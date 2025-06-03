import pool from "../db.js"
import { validationResult } from "express-validator"

// Obtener movimientos de stock con filtros
export const getStockMovements = async (req, res) => {
  try {
    const { productId = "", tipo = "", fechaInicio = "", fechaFin = "", limit = 50, offset = 0 } = req.query

    let query = `
      SELECT 
        sm.id,
        sm.tipo,
        sm.cantidad,
        sm.stock_anterior,
        sm.stock_nuevo,
        sm.motivo,
        sm.notas,
        sm.fecha_movimiento,
        p.codigo as producto_codigo,
        p.nombre as producto_nombre,
        u.nombre as usuario_nombre
      FROM movimientos_stock sm
      JOIN productos p ON sm.producto_id = p.id
      JOIN usuarios u ON sm.usuario_id = u.id
      WHERE 1=1
    `

    const queryParams = []

    // Filtros
    if (productId) {
      query += ` AND sm.producto_id = ?`
      queryParams.push(productId)
    }

    if (tipo) {
      query += ` AND sm.tipo = ?`
      queryParams.push(tipo)
    }

    if (fechaInicio) {
      query += ` AND DATE(sm.fecha_movimiento) >= ?`
      queryParams.push(fechaInicio)
    }

    if (fechaFin) {
      query += ` AND DATE(sm.fecha_movimiento) <= ?`
      queryParams.push(fechaFin)
    }

    query += ` ORDER BY sm.fecha_movimiento DESC LIMIT ? OFFSET ?`
    queryParams.push(Number.parseInt(limit), Number.parseInt(offset))

    const [movements] = await pool.query(query, queryParams)
    res.status(200).json(movements)
  } catch (error) {
    console.error("Error al obtener movimientos de stock:", error)
    res.status(500).json({ message: "Error al obtener movimientos de stock" })
  }
}

// Crear un movimiento de stock
export const createStockMovement = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const { productId, tipo, cantidad, motivo, notas = "" } = req.body

    // Obtener stock actual del producto
    const [productResult] = await connection.query("SELECT stock FROM productos WHERE id = ? AND activo = TRUE", [
      productId,
    ])

    if (productResult.length === 0) {
      await connection.rollback()
      return res.status(404).json({ message: "Producto no encontrado" })
    }

    const stockActual = productResult[0].stock
    let nuevoStock = stockActual

    // Calcular nuevo stock según el tipo de movimiento
    switch (tipo) {
      case "entrada":
        nuevoStock = stockActual + cantidad
        break
      case "salida":
        nuevoStock = Math.max(0, stockActual - cantidad)
        if (cantidad > stockActual) {
          await connection.rollback()
          return res.status(400).json({
            message: "No se puede retirar más stock del disponible",
          })
        }
        break
      case "ajuste":
        nuevoStock = cantidad
        break
      default:
        await connection.rollback()
        return res.status(400).json({ message: "Tipo de movimiento inválido" })
    }

    // Insertar movimiento de stock
    const [movementResult] = await connection.query(
      `
      INSERT INTO movimientos_stock (
        producto_id, usuario_id, tipo, cantidad, 
        stock_anterior, stock_nuevo, motivo, notas
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [productId, req.user.id, tipo, cantidad, stockActual, nuevoStock, motivo, notas],
    )

    // Actualizar stock del producto
    await connection.query("UPDATE productos SET stock = ? WHERE id = ?", [nuevoStock, productId])

    await connection.commit()

    res.status(201).json({
      message: "Movimiento de stock creado exitosamente",
      id: movementResult.insertId,
      nuevoStock,
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al crear movimiento de stock:", error)
    res.status(500).json({ message: "Error al crear movimiento de stock" })
  } finally {
    connection.release()
  }
}

// Obtener movimientos de un producto específico
export const getProductMovements = async (req, res) => {
  try {
    const { productId } = req.params
    const { limit = 20 } = req.query

    const [movements] = await pool.query(
      `
      SELECT 
        sm.id,
        sm.tipo,
        sm.cantidad,
        sm.stock_anterior,
        sm.stock_nuevo,
        sm.motivo,
        sm.notas,
        sm.fecha_movimiento,
        u.nombre as usuario_nombre
      FROM movimientos_stock sm
      JOIN usuarios u ON sm.usuario_id = u.id
      WHERE sm.producto_id = ?
      ORDER BY sm.fecha_movimiento DESC
      LIMIT ?
    `,
      [productId, Number.parseInt(limit)],
    )

    res.status(200).json(movements)
  } catch (error) {
    console.error("Error al obtener movimientos del producto:", error)
    res.status(500).json({ message: "Error al obtener movimientos del producto" })
  }
}
