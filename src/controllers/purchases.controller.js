import pool from "../db.js"
import { validationResult } from "express-validator"
// Add imports for pricing utilities
import { getPricingConfig, calculateSalePrice } from "../lib/pricing.js"

// Función para obtener datos de la empresa desde la configuración
const getCompanyDataFromConfig = async (connection) => {
  try {
    const [config] = await connection.query(`
    SELECT clave, valor FROM configuracion 
    WHERE clave IN (
      'empresa_nombre', 'empresa_telefono', 'empresa_direccion', 'empresa_cuit', 
      'empresa_email', 'empresa_condicion_iva', 'empresa_inicio_actividades'
    )
  `)

    const configObj = {}
    config.forEach((item) => {
      configObj[item.clave] = item.valor || ""
    })

    return {
      nombre: configObj.empresa_nombre || "La Solución Repuestos",
      telefono: configObj.empresa_telefono || "",
      direccion: configObj.empresa_direccion || "",
      cuit: configObj.empresa_cuit || "",
      email: configObj.empresa_email || "",
      condicion_iva: "RESPONSABLE INSCRIPTO",
      inicio_actividades: "01/05/1998",
    }
  } catch (error) {
    console.error("Error al obtener datos de la empresa:", error)
    return {
      nombre: "La Solución Repuestos",
      telefono: "",
      direccion: "",
      cuit: "",
      email: "",
      condicion_iva: "RESPONSABLE INSCRIPTO",
      inicio_actividades: "01/05/1998",
    }
  }
}

// Función para generar el próximo número de compra
const generatePurchaseNumber = async (connection) => {
  try {
    const [config] = await connection.query(`
    SELECT clave, valor FROM configuracion 
    WHERE clave IN ('compra_numero_siguiente', 'compra_prefijo')
    FOR UPDATE
  `)

    if (config.length === 0) {
      throw new Error("No se encontró configuración de numeración de compras")
    }

    const configObj = {}
    config.forEach((item) => {
      configObj[item.clave] = item.valor
    })

    if (!configObj.compra_numero_siguiente) {
      throw new Error("No se encontró el próximo número de compra en la configuración")
    }

    const nextNumber = Number.parseInt(configObj.compra_numero_siguiente)
    if (isNaN(nextNumber) || nextNumber < 1) {
      throw new Error(`Número de compra inválido en configuración: ${configObj.compra_numero_siguiente}`)
    }

    const prefix = configObj.compra_prefijo || "COMP-"
    const purchaseNumber = `${prefix}${nextNumber.toString().padStart(6, "0")}`

    const [updateResult] = await connection.query(
      "UPDATE configuracion SET valor = ? WHERE clave = 'compra_numero_siguiente'",
      [(nextNumber + 1).toString()],
    )

    if (updateResult.affectedRows === 0) {
      throw new Error("No se pudo actualizar el contador de compras")
    }

    return purchaseNumber
  } catch (error) {
    console.error("Error al generar número de compra:", error)
    throw new Error(`Error al generar número de compra: ${error.message}`)
  }
}

// Crear una nueva compra
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
      productos,
      descuento = 0,
      interes = 0,
      observaciones = "",
      pagos = [],
      fechaCompra,
      recibirInmediatamente = false,
    } = req.body

    if (!productos || productos.length === 0) {
      await connection.rollback()
      return res.status(400).json({ message: "Debe incluir al menos un producto" })
    }

    if (!pagos || pagos.length === 0) {
      await connection.rollback()
      return res.status(400).json({ message: "Debe incluir al menos un método de pago" })
    }

    const [proveedorData] = await connection.query(
      "SELECT id, nombre FROM proveedores WHERE id = ? AND activo = TRUE",
      [proveedorId],
    )

    if (proveedorData.length === 0) {
      await connection.rollback()
      return res.status(404).json({ message: "Proveedor no encontrado" })
    }

    let subtotal = 0
    const productosValidados = []

    for (const item of productos) {
      const [producto] = await connection.query(
        "SELECT id, nombre, precio_costo, precio_venta FROM productos WHERE id = ? AND activo = TRUE",
        [item.productoId],
      )

      if (producto.length === 0) {
        await connection.rollback()
        return res.status(404).json({ message: `Producto con ID ${item.productoId} no encontrado` })
      }

      const prod = producto[0]
      const precioUnitario = Number.parseFloat(item.precioUnitario || prod.precio_costo)
      const cantidad = Number.parseInt(item.cantidad)
      const subtotalItem = precioUnitario * cantidad

      // Check if the provided price is different from the current cost price in DB
      if (precioUnitario !== Number.parseFloat(prod.precio_costo)) {
        // Update product's cost price in DB
        await connection.query("UPDATE productos SET precio_costo = ? WHERE id = ?", [precioUnitario, item.productoId])

        // Recalculate and update product's sale price
        const pricingConfig = await getPricingConfig(connection)
        const newSalePrice = calculateSalePrice(precioUnitario, pricingConfig)
        await connection.query("UPDATE productos SET precio_venta = ? WHERE id = ?", [newSalePrice, item.productoId])
      }

      productosValidados.push({
        ...item,
        nombre: prod.nombre,
        precioUnitario,
        cantidad,
        subtotalItem,
      })

      subtotal += subtotalItem
    }

    const descuentoNum = Number.parseFloat(descuento)
    const interesNum = Number.parseFloat(interes)
    const total = subtotal - descuentoNum + interesNum

    const totalPagos = pagos.reduce((sum, pago) => sum + Number.parseFloat(pago.monto), 0)
    if (Math.abs(totalPagos - total) > 0.01) {
      await connection.rollback()
      return res.status(400).json({
        message: `El total de pagos ($${totalPagos.toFixed(2)}) no coincide con el total de la compra ($${total.toFixed(2)})`,
      })
    }

    const numeroCompra = await generatePurchaseNumber(connection)

    if (!numeroCompra) {
      await connection.rollback()
      return res.status(500).json({ message: "Error al generar número de compra" })
    }

    const [compraResult] = await connection.query(
      `
    INSERT INTO compras (
      numero_compra, proveedor_id, usuario_id, fecha_compra,
      subtotal, descuento, interes, total, observaciones
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
      [numeroCompra, proveedorId, req.user.id, fechaCompra, subtotal, descuentoNum, interesNum, total, observaciones],
    )

    const compraId = compraResult.insertId

    for (const item of productosValidados) {
      await connection.query(
        "INSERT INTO detalles_compras (compra_id, producto_id, cantidad, precio_unitario, subtotal) VALUES (?, ?, ?, ?, ?)",
        [compraId, item.productoId, item.cantidad, item.precioUnitario, item.subtotalItem],
      )
    }

    for (const pago of pagos) {
      await connection.query(
        "INSERT INTO compra_pagos (compra_id, tipo_pago, monto, descripcion) VALUES (?, ?, ?, ?)",
        [compraId, pago.tipo, Number.parseFloat(pago.monto), pago.descripcion || ""],
      )
    }

    if (recibirInmediatamente) {
      for (const item of productosValidados) {
        const [stockActual] = await connection.query("SELECT stock FROM productos WHERE id = ?", [item.productoId])
        const nuevoStock = stockActual[0].stock + item.cantidad

        await connection.query("UPDATE productos SET stock = ? WHERE id = ?", [nuevoStock, item.productoId])

        await connection.query(
          `
              INSERT INTO movimientos_stock (
                  producto_id, usuario_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo
              ) VALUES (?, ?, 'entrada', ?, ?, ?, ?)
              `,
          [
            item.productoId,
            req.user.id,
            item.cantidad,
            stockActual[0].stock,
            nuevoStock,
            `Recepción inmediata compra ${numeroCompra}`,
          ],
        )

        await connection.query(
          "UPDATE detalles_compras SET cantidad_recibida = ? WHERE compra_id = ? AND producto_id = ?",
          [item.cantidad, compraId, item.productoId],
        )
      }
      await connection.query("UPDATE compras SET estado = 'recibida' WHERE id = ?", [compraId])
    }

    await connection.commit()

    res.status(201).json({
      message: "Compra creada exitosamente",
      data: {
        id: compraId,
        numeroCompra: numeroCompra,
        total,
      },
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al crear compra:", error)
    res.status(500).json({
      message: error.message || "Error al crear compra",
      details: error.stack,
    })
  } finally {
    connection.release()
  }
}

// Obtener una compra por ID
export const getPurchaseById = async (req, res) => {
  try {
    const { id } = req.params

    const [purchases] = await pool.query(
      `
    SELECT 
      c.*,
      COALESCE(p.nombre, 'Sin Proveedor') as proveedor_nombre,
      p.telefono as proveedor_telefono,
      p.direccion as proveedor_direccion,
      p.cuit as proveedor_cuit,
      u.nombre as usuario_nombre
    FROM compras c
    LEFT JOIN proveedores p ON c.proveedor_id = p.id
    JOIN usuarios u ON c.usuario_id = u.id
    WHERE c.id = ?
  `,
      [id],
    )

    if (purchases.length === 0) {
      return res.status(404).json({ message: "Compra no encontrada" })
    }

    const purchase = purchases[0]

    const [details] = await pool.query(
      `
    SELECT 
      dc.*,
      pr.nombre as producto_nombre,
      pr.codigo as producto_codigo,
      pr.marca as producto_marca
    FROM detalles_compras dc
    JOIN productos pr ON dc.producto_id = pr.id
    WHERE dc.compra_id = ?
    ORDER BY dc.id
  `,
      [id],
    )

    const [payments] = await pool.query(
      `
    SELECT *
    FROM compra_pagos
    WHERE compra_id = ? 
    ORDER BY id
`,
      [id],
    )

    const purchaseData = {
      ...purchase,
      fecha_compra: purchase.fecha_compra.toISOString().split("T")[0],
      fecha_creacion: purchase.fecha_creacion.toISOString(),
      fecha_actualizacion: purchase.fecha_actualizacion.toISOString(),
      detalles: details.map((detail) => ({
        ...detail,
        fecha_creacion: detail.fecha_creacion.toISOString(),
      })),
      pagos: payments.map((payment) => ({
        ...payment,
        fecha_creacion: payment.fecha_creacion.toISOString(),
      })),
    }

    res.status(200).json({
      success: true,
      data: purchaseData,
    })
  } catch (error) {
    console.error("Error al obtener compra:", error)
    res.status(500).json({ message: "Error al obtener compra" })
  }
}

// Obtener compras para reportes CON PAGINACIÓN
export const getPurchasesForReports = async (req, res) => {
  try {
    const {
      fechaInicio = "",
      fechaFin = "",
      proveedor = "",
      numeroCompra = "",
      estado = "todos",
      tipoPago = "todos",
      limit = 10,
      offset = 0,
    } = req.query

    let baseQuery = `
    FROM compras c
    LEFT JOIN proveedores p ON c.proveedor_id = p.id
    JOIN usuarios u ON c.usuario_id = u.id
    WHERE 1=1
  `

    const queryParams = []

    if (fechaInicio) {
      baseQuery += ` AND DATE(c.fecha_compra) >= ?`
      queryParams.push(fechaInicio)
    }

    if (fechaFin) {
      baseQuery += ` AND DATE(c.fecha_compra) <= ?`
      queryParams.push(fechaFin)
    }

    if (proveedor) {
      baseQuery += ` AND COALESCE(p.nombre, 'Sin Proveedor') LIKE ?`
      queryParams.push(`%${proveedor}%`)
    }

    if (estado !== "todos") {
      baseQuery += ` AND c.estado = ?`
      queryParams.push(estado)
    }

    if (numeroCompra) {
      baseQuery += ` AND c.numero_compra LIKE ?`
      queryParams.push(`%${numeroCompra}%`)
    }

    if (tipoPago !== "todos") {
      if (tipoPago === "varios") {
        baseQuery += ` AND (SELECT COUNT(cp.id) FROM compra_pagos cp WHERE cp.compra_id = c.id) > 1`
      } else {
        baseQuery += ` AND EXISTS (SELECT 1 FROM compra_pagos cp WHERE cp.compra_id = c.id AND cp.tipo_pago = ?)`
        queryParams.push(tipoPago)
      }
    }

    // Consulta de conteo
    const countQuery = `SELECT COUNT(*) as total ${baseQuery}`
    const [[{ total }]] = await pool.query(countQuery, queryParams)

    // Consulta de datos con paginación
    const dataQuery = `
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
      COALESCE(p.nombre, 'Sin Proveedor') as proveedor_nombre,
      u.nombre as usuario_nombre
    ${baseQuery}
    ORDER BY c.fecha_compra DESC, c.id DESC
    LIMIT ? OFFSET ?
  `
    const finalDataParams = [...queryParams, Number.parseInt(limit), Number.parseInt(offset)]
    const [purchases] = await pool.query(dataQuery, finalDataParams)

    // Obtener pagos para cada compra
    const purchasesWithPayments = await Promise.all(
      purchases.map(async (purchase) => {
        const [payments] = await pool.query("SELECT * FROM compra_pagos WHERE compra_id = ?", [purchase.id])
        return {
          ...purchase,
          fecha_compra: purchase.fecha_compra.toISOString().split("T")[0],
          fecha_creacion: purchase.fecha_creacion.toISOString(),
          pagos: payments,
        }
      }),
    )

    res.status(200).json({
      success: true,
      data: purchasesWithPayments,
      pagination: {
        totalItems: total,
        totalPages: Math.ceil(total / limit),
        currentPage: Math.floor(offset / limit) + 1,
        itemsPerPage: Number.parseInt(limit),
      },
    })
  } catch (error) {
    console.error("Error al obtener compras para reportes:", error)
    res.status(500).json({
      success: false,
      message: "Error al obtener compras para reportes",
    })
  }
}

// Obtener estadísticas de compras
export const getPurchaseStats = async (req, res) => {
  try {
    const { fechaInicio = "", fechaFin = "" } = req.query

    let whereClause = "WHERE 1=1"
    const queryParams = []

    if (fechaInicio) {
      whereClause += " AND DATE(c.fecha_compra) >= ?"
      queryParams.push(fechaInicio)
    }

    if (fechaFin) {
      whereClause += " AND DATE(c.fecha_compra) <= ?"
      queryParams.push(fechaFin)
    }

    // Estadísticas generales
    const [generalStats] = await pool.query(
      `
    SELECT 
      COUNT(*) as totalCompras,
      SUM(c.total) as montoTotal,
      AVG(c.total) as promedioCompra,
      SUM(CASE WHEN c.estado = 'recibida' THEN 1 ELSE 0 END) as comprasRecibidas,
      SUM(CASE WHEN c.estado = 'pendiente' THEN 1 ELSE 0 END) as comprasPendientes,
      SUM(CASE WHEN c.estado = 'parcial' THEN 1 ELSE 0 END) as comprasParciales,
      SUM(CASE WHEN c.estado = 'cancelada' THEN 1 ELSE 0 END) as comprasCanceladas
    FROM compras c
    ${whereClause}
  `,
      queryParams,
    )

    // Compras por día
    const [purchasesByDay] = await pool.query(
      `
    SELECT 
      DATE(c.fecha_compra) as fecha,
      COUNT(*) as cantidad_compras,
      SUM(c.total) as total_dia
    FROM compras c
    ${whereClause}
    GROUP BY DATE(c.fecha_compra)
    ORDER BY fecha DESC
    LIMIT 30
  `,
      queryParams,
    )

    // Top proveedores
    const [topProviders] = await pool.query(
      `
    SELECT 
      p.id,
      COALESCE(p.nombre, 'Sin Proveedor') as nombre,
      COUNT(c.id) as cantidad_compras,
      SUM(c.total) as total_comprado
    FROM compras c
    LEFT JOIN proveedores p ON c.proveedor_id = p.id
    ${whereClause}
    GROUP BY p.id, p.nombre
    ORDER BY total_comprado DESC
    LIMIT 10
  `,
      queryParams,
    )

    // Métodos de pago
    const [paymentMethods] = await pool.query(
      `
    SELECT 
      cp.tipo_pago,
      COUNT(cp.id) as cantidad_usos,
      SUM(cp.monto) as total_monto
    FROM compra_pagos cp
    JOIN compras c ON cp.compra_id = c.id
    ${whereClause.replace("WHERE", "WHERE")}
    GROUP BY cp.tipo_pago
    ORDER BY total_monto DESC
  `,
      queryParams,
    )

    const stats = {
      ...generalStats[0],
      compras_por_dia: purchasesByDay.map((day) => ({
        ...day,
        fecha: day.fecha.toISOString().split("T")[0],
      })),
      top_proveedores: topProviders,
      metodos_pago: paymentMethods,
    }

    res.status(200).json({
      success: true,
      data: stats,
    })
  } catch (error) {
    console.error("Error al obtener estadísticas:", error)
    res.status(500).json({
      success: false,
      message: "Error al obtener estadísticas",
    })
  }
}

// Obtener compras CON PAGINACIÓN
export const getPurchases = async (req, res) => {
  try {
    const { fechaInicio = "", fechaFin = "", proveedor = "", estado = "todos", limit = 10, offset = 0 } = req.query

    let baseQuery = `
    FROM compras c
    LEFT JOIN proveedores p ON c.proveedor_id = p.id
    JOIN usuarios u ON c.usuario_id = u.id
    WHERE 1=1
  `

    const queryParams = []

    if (fechaInicio) {
      baseQuery += ` AND DATE(c.fecha_compra) >= ?`
      queryParams.push(fechaInicio)
    }

    if (fechaFin) {
      baseQuery += ` AND DATE(c.fecha_compra) <= ?`
      queryParams.push(fechaFin)
    }

    if (proveedor) {
      baseQuery += ` AND COALESCE(p.nombre, 'Sin Proveedor') LIKE ?`
      queryParams.push(`%${proveedor}%`)
    }

    if (estado !== "todos") {
      baseQuery += ` AND c.estado = ?`
      queryParams.push(estado)
    }

    // Consulta de conteo
    const countQuery = `SELECT COUNT(*) as total ${baseQuery}`
    const [[{ total }]] = await pool.query(countQuery, queryParams)

    // Consulta de datos con paginación
    const dataQuery = `
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
      COALESCE(p.nombre, 'Sin Proveedor') as proveedor_nombre,
      u.nombre as usuario_nombre
    ${baseQuery}
    ORDER BY c.fecha_compra DESC, c.id DESC
    LIMIT ? OFFSET ?
  `
    const finalDataParams = [...queryParams, Number.parseInt(limit), Number.parseInt(offset)]
    const [purchases] = await pool.query(dataQuery, finalDataParams)

    const purchasesWithISODate = purchases.map((purchase) => ({
      ...purchase,
      fecha_compra: purchase.fecha_compra.toISOString().split("T")[0],
      fecha_creacion: purchase.fecha_creacion.toISOString(),
    }))

    res.status(200).json({
      success: true,
      data: purchasesWithISODate,
      pagination: {
        totalItems: total,
        totalPages: Math.ceil(total / limit),
        currentPage: Math.floor(offset / limit) + 1,
        itemsPerPage: Number.parseInt(limit),
      },
    })
  } catch (error) {
    console.error("Error al obtener compras:", error)
    res.status(500).json({
      success: false,
      message: "Error al obtener compras",
    })
  }
}

// Recibir productos de compra
export const receivePurchaseItems = async (req, res) => {
  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const { id } = req.params
    const { detallesRecibidos } = req.body

    const [purchases] = await connection.query("SELECT * FROM compras WHERE id = ?", [id])

    if (purchases.length === 0) {
      await connection.rollback()
      return res.status(404).json({ message: "Compra no encontrada" })
    }

    const purchase = purchases[0]

    if (purchase.estado === "cancelada") {
      await connection.rollback()
      return res.status(400).json({ message: "No se pueden recibir productos de una compra cancelada" })
    }

    for (const detalle of detallesRecibidos) {
      const [detalleCompra] = await connection.query("SELECT * FROM detalles_compras WHERE id = ? AND compra_id = ?", [
        detalle.detalleId,
        id,
      ])

      if (detalleCompra.length === 0) {
        await connection.rollback()
        return res.status(404).json({ message: `Detalle de compra ${detalle.detalleId} no encontrado` })
      }

      const detalleData = detalleCompra[0]
      const nuevaCantidadRecibida = detalleData.cantidad_recibida + detalle.cantidadRecibida

      if (nuevaCantidadRecibida > detalleData.cantidad) {
        await connection.rollback()
        return res.status(400).json({
          message: `La cantidad a recibir excede la cantidad pendiente para el producto ${detalleData.producto_id}`,
        })
      }

      // Actualizar cantidad recibida
      await connection.query("UPDATE detalles_compras SET cantidad_recibida = ? WHERE id = ?", [
        nuevaCantidadRecibida,
        detalle.detalleId,
      ])

      // Actualizar stock del producto
      const [stockActual] = await connection.query("SELECT stock FROM productos WHERE id = ?", [
        detalleData.producto_id,
      ])
      const nuevoStock = stockActual[0].stock + detalle.cantidadRecibida

      await connection.query("UPDATE productos SET stock = ? WHERE id = ?", [nuevoStock, detalleData.producto_id])

      // Registrar movimiento de stock
      await connection.query(
        `
      INSERT INTO movimientos_stock (
        producto_id, usuario_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo
      ) VALUES (?, ?, 'entrada', ?, ?, ?, ?)
    `,
        [
          detalleData.producto_id,
          req.user.id,
          detalle.cantidadRecibida,
          stockActual[0].stock,
          nuevoStock,
          `Recepción compra ${purchase.numero_compra}`,
        ],
      )
    }

    // Verificar si todos los productos están completamente recibidos
    const [pendingItems] = await connection.query(
      "SELECT COUNT(*) as pending FROM detalles_compras WHERE compra_id = ? AND cantidad_recibida < cantidad",
      [id],
    )

    let nuevoEstado = purchase.estado
    if (pendingItems[0].pending === 0) {
      nuevoEstado = "recibida"
    } else if (purchase.estado === "pendiente") {
      nuevoEstado = "parcial"
    }

    if (nuevoEstado !== purchase.estado) {
      await connection.query("UPDATE compras SET estado = ? WHERE id = ?", [nuevoEstado, id])
    }

    await connection.commit()

    res.status(200).json({
      success: true,
      message: "Productos recibidos exitosamente",
      data: {
        id,
        estado: nuevoEstado,
      },
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al recibir productos:", error)
    res.status(500).json({ message: error.message || "Error al recibir productos" })
  } finally {
    connection.release()
  }
}

// Cancelar compra
export const cancelPurchase = async (req, res) => {
  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const { id } = req.params
    const { motivo = "" } = req.body

    const [purchases] = await connection.query("SELECT * FROM compras WHERE id = ? AND estado != 'cancelada'", [id])

    if (purchases.length === 0) {
      await connection.rollback()
      return res.status(404).json({ message: "Compra no encontrada o ya está cancelada" })
    }

    const purchase = purchases[0]

    // If there are products received, revert the stock
    const [receivedItems] = await connection.query(
      "SELECT * FROM detalles_compras WHERE compra_id = ? AND cantidad_recibida > 0",
      [id],
    )

    for (const item of receivedItems) {
      const [stockActual] = await connection.query("SELECT stock FROM productos WHERE id = ?", [item.producto_id])
      const nuevoStock = Math.max(0, stockActual[0].stock - item.cantidad_recibida)

      await connection.query("UPDATE productos SET stock = ? WHERE id = ?", [nuevoStock, item.producto_id])

      await connection.query(
        `
      INSERT INTO movimientos_stock (
        producto_id, usuario_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo
      ) VALUES (?, ?, 'salida', ?, ?, ?, ?)
    `,
        [
          item.producto_id,
          req.user.id,
          item.cantidad_recibida,
          stockActual[0].stock,
          nuevoStock,
          `Cancelación compra ${purchase.numero_compra} - ${motivo}`,
        ],
      )
    }

    await connection.query(
      "UPDATE compras SET estado = 'cancelada', observaciones = CONCAT(COALESCE(observaciones, ''), ' - CANCELADA: ', ?) WHERE id = ?",
      [motivo, id],
    )

    await connection.commit()

    res.status(200).json({
      success: true,
      message: "Compra cancelada exitosamente",
      data: {
        id,
        numeroCompra: purchase.numero_compra,
        motivo,
      },
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al cancelar compra:", error)
    res.status(500).json({ message: error.message || "Error al cancelar compra" })
  } finally {
    connection.release()
  }
}

// Actualizar compra
export const updatePurchase = async (req, res) => {
  try {
    const { id } = req.params
    const { observaciones } = req.body

    const [result] = await pool.query("UPDATE compras SET observaciones = ? WHERE id = ?", [observaciones, id])

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Compra no encontrada" })
    }

    res.status(200).json({
      success: true,
      message: "Compra actualizada exitosamente",
      data: { id, observaciones },
    })
  } catch (error) {
    console.error("Error al actualizar compra:", error)
    res.status(500).json({ message: "Error al actualizar compra" })
  }
}
