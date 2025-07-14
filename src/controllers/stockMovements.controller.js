import pool from "../db.js"
import { validationResult } from "express-validator"

// Obtener movimientos de stock con filtros Y PAGINACIÓN
export const getStockMovements = async (req, res) => {
  try {
    const {
      search = "",
      productId = "",
      tipo = "",
      fechaInicio = "",
      fechaFin = "",
      limit = 20,
      offset = 0,
    } = req.query

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
    if (search) {
      query += ` AND (p.nombre LIKE ? OR p.codigo LIKE ?)`
      queryParams.push(`%${search}%`, `%${search}%`)
    }

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

    // Query para contar el total de resultados sin paginación
    let countQuery = `
      SELECT COUNT(*) as total
      FROM movimientos_stock sm
      JOIN productos p ON sm.producto_id = p.id
      WHERE 1=1
    `
    const countParams = []

    if (search) {
      countQuery += ` AND (p.nombre LIKE ? OR p.codigo LIKE ?)`
      countParams.push(`%${search}%`, `%${search}%`)
    }

    if (productId) {
      countQuery += ` AND sm.producto_id = ?`
      countParams.push(productId)
    }

    if (tipo) {
      countQuery += ` AND sm.tipo = ?`
      countParams.push(tipo)
    }

    if (fechaInicio) {
      countQuery += ` AND DATE(sm.fecha_movimiento) >= ?`
      countParams.push(fechaInicio)
    }

    if (fechaFin) {
      countQuery += ` AND DATE(sm.fecha_movimiento) <= ?`
      countParams.push(fechaFin)
    }

    // Ejecutar query de conteo
    const [totalResult] = await pool.query(countQuery, countParams)
    const total = totalResult[0].total

    // Agregar ordenamiento y paginación a la query principal
    query += ` ORDER BY sm.fecha_movimiento DESC LIMIT ? OFFSET ?`
    queryParams.push(Number.parseInt(limit), Number.parseInt(offset))

    // Ejecutar query principal
    const [movements] = await pool.query(query, queryParams)

    // Calcular información de paginación
    const limitNum = Number.parseInt(limit)
    const offsetNum = Number.parseInt(offset)
    const currentPage = Math.floor(offsetNum / limitNum) + 1
    const totalPages = Math.ceil(total / limitNum)

    const pagination = {
      currentPage,
      totalPages,
      totalItems: total,
      itemsPerPage: limitNum,
      hasNextPage: currentPage < totalPages,
      hasPrevPage: currentPage > 1,
    }

    console.log("Controller: Returning pagination:", pagination) // Para debug

    res.status(200).json({
      success: true,
      data: {
        movements,
        total,
      },
      pagination,
    })
  } catch (error) {
    console.error("Error al obtener movimientos de stock:", error)
    res.status(500).json({
      success: false,
      message: "Error al obtener movimientos de stock",
      data: { movements: [], total: 0 },
      pagination: null,
    })
  }
}

// Crear un movimiento de stock
export const createStockMovement = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: "Datos inválidos",
      errors: errors.array(),
    })
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
      return res.status(404).json({
        success: false,
        message: "Producto no encontrado",
      })
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
            success: false,
            message: "No se puede retirar más stock del disponible",
          })
        }
        break
      case "ajuste":
        nuevoStock = cantidad
        break
      default:
        await connection.rollback()
        return res.status(400).json({
          success: false,
          message: "Tipo de movimiento inválido",
        })
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
      success: true,
      message: "Movimiento de stock creado exitosamente",
      data: {
        id: movementResult.insertId,
        nuevoStock,
      },
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al crear movimiento de stock:", error)
    res.status(500).json({
      success: false,
      message: "Error al crear movimiento de stock",
    })
  } finally {
    connection.release()
  }
}

// Obtener movimientos de un producto específico CON PAGINACIÓN
export const getProductMovements = async (req, res) => {
  try {
    const { productId } = req.params
    const { limit = 20, offset = 0 } = req.query

    // Query para contar el total
    const [totalResult] = await pool.query(`SELECT COUNT(*) as total FROM movimientos_stock WHERE producto_id = ?`, [
      productId,
    ])
    const total = totalResult[0].total

    // Query principal con paginación
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
      LIMIT ? OFFSET ?
    `,
      [productId, Number.parseInt(limit), Number.parseInt(offset)],
    )

    // Calcular información de paginación
    const limitNum = Number.parseInt(limit)
    const offsetNum = Number.parseInt(offset)
    const currentPage = Math.floor(offsetNum / limitNum) + 1
    const totalPages = Math.ceil(total / limitNum)

    const pagination = {
      currentPage,
      totalPages,
      totalItems: total,
      itemsPerPage: limitNum,
      hasNextPage: currentPage < totalPages,
      hasPrevPage: currentPage > 1,
    }

    res.status(200).json({
      success: true,
      data: {
        movements,
        total,
      },
      pagination,
    })
  } catch (error) {
    console.error("Error al obtener movimientos del producto:", error)
    res.status(500).json({
      success: false,
      message: "Error al obtener movimientos del producto",
      data: { movements: [], total: 0 },
      pagination: null,
    })
  }
}
