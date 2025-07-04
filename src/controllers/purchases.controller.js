import pool from "../db.js"
import { validationResult } from "express-validator"

// Función para generar el próximo número de compra
const generatePurchaseNumber = async (connection) => {
  try {
    // Obtener configuración de numeración
    const [config] = await connection.query(`
      SELECT clave, valor FROM configuracion 
      WHERE clave IN ('compra_numero_siguiente', 'compra_prefijo')
    `)

    const configObj = {}
    config.forEach((item) => {
      configObj[item.clave] = item.valor
    })

    const nextNumber = Number.parseInt(configObj.compra_numero_siguiente || 1)
    const prefix = configObj.compra_prefijo || "COMP-"
    const purchaseNumber = `${prefix}${nextNumber.toString().padStart(6, "0")}`

    // Actualizar el siguiente número
    await connection.query("UPDATE configuracion SET valor = ? WHERE clave = 'compra_numero_siguiente'", [
      (nextNumber + 1).toString(),
    ])

    return purchaseNumber
  } catch (error) {
    console.error("Error al generar número de compra:", error)
    throw error
  }
}

// Obtener todas las compras con filtros
export const getPurchases = async (req, res) => {
  try {
    const { proveedor = "", estado = "", fechaInicio = "", fechaFin = "", limit = 50, offset = 0 } = req.query

    let query = `
      SELECT 
        c.id,
        c.numero_compra,
        c.fecha_compra,
        c.subtotal,
        c.descuento,
        c.interes,
        c.total,
        c.estado,
        c.observaciones,
        c.fecha_creacion,
        p.nombre as proveedor_nombre,
        u.nombre as usuario_nombre,
        COUNT(dc.id) as total_items
      FROM compras c
      JOIN proveedores p ON c.proveedor_id = p.id
      JOIN usuarios u ON c.usuario_id = u.id
      LEFT JOIN detalles_compras dc ON c.id = dc.compra_id
      WHERE 1=1
    `

    const queryParams = []

    // Filtros
    if (proveedor) {
      query += ` AND p.nombre LIKE ?`
      queryParams.push(`%${proveedor}%`)
    }

    if (estado) {
      query += ` AND c.estado = ?`
      queryParams.push(estado)
    }

    if (fechaInicio) {
      query += ` AND DATE(c.fecha_compra) >= ?`
      queryParams.push(fechaInicio)
    }

    if (fechaFin) {
      query += ` AND DATE(c.fecha_compra) <= ?`
      queryParams.push(fechaFin)
    }

    query += ` GROUP BY c.id ORDER BY c.fecha_compra DESC, c.id DESC LIMIT ? OFFSET ?`
    queryParams.push(Number.parseInt(limit), Number.parseInt(offset))

    const [purchases] = await pool.query(query, queryParams)

    // Convertir fechas a ISO
    const purchasesWithISODate = purchases.map((purchase) => ({
      ...purchase,
      fecha_compra: purchase.fecha_compra.toISOString().split("T")[0],
      fecha_creacion: purchase.fecha_creacion.toISOString(),
    }))

    res.status(200).json(purchasesWithISODate)
  } catch (error) {
    console.error("Error al obtener compras:", error)
    res.status(500).json({ message: "Error al obtener compras" })
  }
}

// Obtener una compra por ID con sus detalles
export const getPurchaseById = async (req, res) => {
  try {
    const { id } = req.params

    // Obtener datos principales de la compra
    const [purchases] = await pool.query(
      `
      SELECT 
        c.id,
        c.numero_compra,
        c.proveedor_id,
        c.fecha_compra,
        c.subtotal,
        c.descuento,
        c.interes,
        c.total,
        c.estado,
        c.observaciones,
        c.fecha_creacion,
        p.nombre as proveedor_nombre,
        u.nombre as usuario_nombre
      FROM compras c
      JOIN proveedores p ON c.proveedor_id = p.id
      JOIN usuarios u ON c.usuario_id = u.id
      WHERE c.id = ?
    `,
      [id],
    )

    if (purchases.length === 0) {
      return res.status(404).json({ message: "Compra no encontrada" })
    }

    // Obtener detalles de la compra
    const [details] = await pool.query(
      `
      SELECT 
        dc.id,
        dc.producto_id,
        dc.cantidad,
        dc.precio_unitario,
        dc.subtotal,
        dc.cantidad_recibida,
        p.codigo as producto_codigo,
        p.nombre as producto_nombre,
        p.marca as producto_marca
      FROM detalles_compras dc
      JOIN productos p ON dc.producto_id = p.id
      WHERE dc.compra_id = ?
      ORDER BY dc.id
    `,
      [id],
    )

    // Obtener métodos de pago de la compra
    const [payments] = await pool.query(
      `
      SELECT 
        cp.id,
        cp.tipo_pago,
        cp.monto,
        cp.descripcion,
        cp.fecha_creacion
      FROM compra_pagos cp
      WHERE cp.compra_id = ? 
      ORDER BY cp.id
    `,
      [id],
    )

    const purchase = {
      ...purchases[0],
      fecha_compra: purchases[0].fecha_compra.toISOString().split("T")[0],
      fecha_creacion: purchases[0].fecha_creacion.toISOString(),
      detalles: details,
      pagos: payments.map((payment) => ({
        ...payment,
        fecha_creacion: payment.fecha_creacion.toISOString(),
      })),
    }

    res.status(200).json(purchase)
  } catch (error) {
    console.error("Error al obtener compra:", error)
    res.status(500).json({ message: "Error al obtener compra" })
  }
}

// CORREGIDO: Crear una nueva compra con cálculo correcto de totales
export const createPurchase = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const {
      proveedorId,
      fechaCompra,
      descuento = 0,
      interes = 0, // NUEVO: Campo para interés
      observaciones = "",
      detalles,
      recibirInmediatamente = false,
      pagos = [],
    } = req.body

    // Validar que hay detalles
    if (!detalles || detalles.length === 0) {
      await connection.rollback()
      return res.status(400).json({ message: "La compra debe tener al menos un producto" })
    }

    // Validar que hay al menos un método de pago
    if (!pagos || pagos.length === 0) {
      await connection.rollback()
      return res.status(400).json({ message: "Debe incluir al menos un método de pago" })
    }

    // Validar que el proveedor existe
    const [supplier] = await connection.query("SELECT id FROM proveedores WHERE id = ? AND activo = TRUE", [
      proveedorId,
    ])
    if (supplier.length === 0) {
      await connection.rollback()
      return res.status(400).json({ message: "Proveedor no encontrado" })
    }

    // CORREGIDO: Calcular totales correctamente
    let subtotal = 0
    for (const detalle of detalles) {
      const itemSubtotal = detalle.cantidad * detalle.precioUnitario
      subtotal += itemSubtotal
    }

    // Calcular el total final incluyendo descuento e interés
    const descuentoAmount = Number.parseFloat(descuento || 0)
    const interesAmount = Number.parseFloat(interes || 0)
    const totalFinal = subtotal - descuentoAmount + interesAmount

    // CORREGIDO: Validar que el total de pagos coincida con el total final
    const totalPagos = pagos.reduce((sum, pago) => sum + Number.parseFloat(pago.monto), 0)

    // Usamos una tolerancia de 0.01 para evitar problemas de redondeo
    if (Math.abs(totalPagos - totalFinal) > 0.01) {
      await connection.rollback()
      return res.status(400).json({
        message: `El total de pagos ($${totalPagos.toFixed(2)}) no coincide con el total de la compra ($${totalFinal.toFixed(2)})`,
        debug: {
          subtotal: subtotal,
          descuento: descuentoAmount,
          interes: interesAmount,
          totalCalculado: totalFinal,
          totalPagos: totalPagos,
          diferencia: Math.abs(totalPagos - totalFinal),
        },
      })
    }

    // Determinar estado inicial basado en si se recibe inmediatamente
    const estadoInicial = recibirInmediatamente ? "recibida" : "pendiente"

    // Generar número de compra
    const numeroCompra = await generatePurchaseNumber(connection)

    // CORREGIDO: Insertar compra con interés
    const [purchaseResult] = await connection.query(
      `
      INSERT INTO compras (
        numero_compra, proveedor_id, usuario_id, fecha_compra, 
        subtotal, descuento, interes, total, estado, observaciones
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        numeroCompra,
        proveedorId,
        req.user.id,
        fechaCompra,
        subtotal,
        descuentoAmount,
        interesAmount,
        totalFinal,
        estadoInicial,
        observaciones,
      ],
    )

    const compraId = purchaseResult.insertId

    // Insertar detalles y manejar stock si se recibe inmediatamente
    for (const detalle of detalles) {
      const { productoId, cantidad, precioUnitario } = detalle
      const itemSubtotal = cantidad * precioUnitario

      // Validar que el producto existe
      const [product] = await connection.query("SELECT id, stock FROM productos WHERE id = ? AND activo = TRUE", [
        productoId,
      ])
      if (product.length === 0) {
        await connection.rollback()
        return res.status(400).json({
          message: `Producto con ID ${productoId} no encontrado`,
        })
      }

      // Determinar cantidad recibida
      const cantidadRecibida = recibirInmediatamente ? cantidad : 0

      // Insertar detalle de compra
      await connection.query(
        `
        INSERT INTO detalles_compras (
          compra_id, producto_id, cantidad, precio_unitario, subtotal, cantidad_recibida
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
        [compraId, productoId, cantidad, precioUnitario, itemSubtotal, cantidadRecibida],
      )

      // Si se recibe inmediatamente, actualizar stock y crear movimiento
      if (recibirInmediatamente) {
        const stockAnterior = product[0].stock
        const nuevoStock = stockAnterior + cantidad

        // Actualizar stock del producto
        await connection.query("UPDATE productos SET stock = ? WHERE id = ?", [nuevoStock, productoId])

        // Crear movimiento de stock
        await connection.query(
          `
          INSERT INTO movimientos_stock (
            producto_id, usuario_id, tipo, cantidad, 
            stock_anterior, stock_nuevo, motivo
          ) VALUES (?, ?, 'entrada', ?, ?, ?, ?)
        `,
          [
            productoId,
            req.user.id,
            cantidad,
            stockAnterior,
            nuevoStock,
            `Compra recibida inmediatamente - ${numeroCompra}`,
          ],
        )
      }
    }

    // Insertar métodos de pago
    for (const pago of pagos) {
      await connection.query(
        "INSERT INTO compra_pagos (compra_id, tipo_pago, monto, descripcion) VALUES (?, ?, ?, ?)",
        [compraId, pago.tipo, Number.parseFloat(pago.monto), pago.descripcion || ""],
      )
    }

    await connection.commit()

    res.status(201).json({
      message: recibirInmediatamente
        ? "Compra creada y productos recibidos exitosamente"
        : "Compra creada exitosamente",
      id: compraId,
      numeroCompra,
      estado: estadoInicial,
      totales: {
        subtotal,
        descuento: descuentoAmount,
        interes: interesAmount,
        total: totalFinal,
      },
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al crear compra:", error)
    res.status(500).json({
      message: "Error al crear compra",
      error: error.message,
    })
  } finally {
    connection.release()
  }
}

// Resto de funciones sin cambios...
export const updatePurchaseStatus = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  try {
    const { id } = req.params
    const { estado, observaciones = "" } = req.body

    // Verificar que la compra existe
    const [existing] = await pool.query("SELECT id, estado FROM compras WHERE id = ?", [id])
    if (existing.length === 0) {
      return res.status(404).json({ message: "Compra no encontrada" })
    }

    // Actualizar estado
    await pool.query("UPDATE compras SET estado = ?, observaciones = ? WHERE id = ?", [estado, observaciones, id])

    res.status(200).json({ message: "Estado de compra actualizado exitosamente" })
  } catch (error) {
    console.error("Error al actualizar estado de compra:", error)
    res.status(500).json({ message: "Error al actualizar estado de compra" })
  }
}

export const receivePurchaseItems = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const { id } = req.params
    const { detallesRecibidos } = req.body

    // Verificar que la compra existe
    const [purchase] = await connection.query("SELECT id, estado, numero_compra FROM compras WHERE id = ?", [id])
    if (purchase.length === 0) {
      await connection.rollback()
      return res.status(404).json({ message: "Compra no encontrada" })
    }

    let allItemsReceived = true

    for (const item of detallesRecibidos) {
      const { detalleId, cantidadRecibida } = item

      // Obtener detalle actual
      const [detail] = await connection.query(
        `
        SELECT dc.*, p.stock 
        FROM detalles_compras dc
        JOIN productos p ON dc.producto_id = p.id
        WHERE dc.id = ? AND dc.compra_id = ?
      `,
        [detalleId, id],
      )

      if (detail.length === 0) {
        await connection.rollback()
        return res.status(400).json({
          message: `Detalle de compra ${detalleId} no encontrado`,
        })
      }

      const detalle = detail[0]
      const nuevaCantidadRecibida = detalle.cantidad_recibida + cantidadRecibida

      // Validar que no se reciba más de lo solicitado
      if (nuevaCantidadRecibida > detalle.cantidad) {
        await connection.rollback()
        return res.status(400).json({
          message: `No se puede recibir más cantidad de la solicitada para el producto`,
        })
      }

      // Actualizar cantidad recibida
      await connection.query("UPDATE detalles_compras SET cantidad_recibida = ? WHERE id = ?", [
        nuevaCantidadRecibida,
        detalleId,
      ])

      // Actualizar stock del producto
      const nuevoStock = detalle.stock + cantidadRecibida
      await connection.query("UPDATE productos SET stock = ? WHERE id = ?", [nuevoStock, detalle.producto_id])

      // Crear movimiento de stock
      await connection.query(
        `
        INSERT INTO movimientos_stock (
          producto_id, usuario_id, tipo, cantidad, 
          stock_anterior, stock_nuevo, motivo
        ) VALUES (?, ?, 'entrada', ?, ?, ?, ?)
      `,
        [
          detalle.producto_id,
          req.user.id,
          cantidadRecibida,
          detalle.stock,
          nuevoStock,
          `Recepción de compra ${purchase[0].numero_compra || id}`,
        ],
      )

      // Verificar si este item está completamente recibido
      if (nuevaCantidadRecibida < detalle.cantidad) {
        allItemsReceived = false
      }
    }

    // Actualizar estado de la compra
    let nuevoEstado = "parcial"
    if (allItemsReceived) {
      // Verificar si todos los items de la compra están completamente recibidos
      const [pendingItems] = await connection.query(
        `
        SELECT COUNT(*) as pending 
        FROM detalles_compras 
        WHERE compra_id = ? AND cantidad_recibida < cantidad
      `,
        [id],
      )

      if (pendingItems[0].pending === 0) {
        nuevoEstado = "recibida"
      }
    }

    await connection.query("UPDATE compras SET estado = ? WHERE id = ?", [nuevoEstado, id])

    await connection.commit()

    res.status(200).json({
      message: "Productos recibidos exitosamente",
      nuevoEstado,
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al recibir productos:", error)
    res.status(500).json({ message: "Error al recibir productos" })
  } finally {
    connection.release()
  }
}

export const cancelPurchase = async (req, res) => {
  try {
    const { id } = req.params

    // Verificar que la compra existe y no está recibida
    const [existing] = await pool.query("SELECT id, estado FROM compras WHERE id = ?", [id])
    if (existing.length === 0) {
      return res.status(404).json({ message: "Compra no encontrada" })
    }

    if (existing[0].estado === "recibida") {
      return res.status(400).json({
        message: "No se puede cancelar una compra que ya fue recibida",
      })
    }

    // Actualizar estado a cancelada
    await pool.query("UPDATE compras SET estado = 'cancelada' WHERE id = ?", [id])

    res.status(200).json({ message: "Compra cancelada exitosamente" })
  } catch (error) {
    console.error("Error al cancelar compra:", error)
    res.status(500).json({ message: "Error al cancelar compra" })
  }
}

export const getPurchasePaymentStats = async (req, res) => {
  try {
    const { fechaInicio = "", fechaFin = "" } = req.query

    let whereClause = "WHERE c.estado != 'cancelada'"
    const queryParams = []

    if (fechaInicio) {
      whereClause += " AND DATE(c.fecha_compra) >= ?"
      queryParams.push(fechaInicio)
    }

    if (fechaFin) {
      whereClause += " AND DATE(c.fecha_compra) <= ?"
      queryParams.push(fechaFin)
    }

    // Métodos de pago más utilizados en compras
    const [metodosPago] = await pool.query(
      `
      SELECT 
        cp.tipo_pago,
        COUNT(*) as cantidad_usos,
        SUM(cp.monto) as total_monto
      FROM compra_pagos cp
      JOIN compras c ON cp.compra_id = c.id
      ${whereClause}
      GROUP BY cp.tipo_pago
      ORDER BY total_monto DESC
    `,
      queryParams,
    )

    res.status(200).json({
      metodos_pago: metodosPago,
    })
  } catch (error) {
    console.error("Error al obtener estadísticas de métodos de pago:", error)
    res.status(500).json({ message: "Error al obtener estadísticas de métodos de pago" })
  }
}
