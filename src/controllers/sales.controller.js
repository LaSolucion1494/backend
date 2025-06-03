// sales.controller.js
import pool from "../db.js"
import { validationResult } from "express-validator"

// Función para generar el próximo número de factura
const generateInvoiceNumber = async (connection) => {
  try {
    // Obtener configuración de numeración
    const [config] = await connection.query(`
      SELECT clave, valor FROM configuracion 
      WHERE clave IN ('venta_numero_siguiente', 'venta_prefijo')
    `)
    
    const configObj = {}
    config.forEach(item => {
      configObj[item.clave] = item.valor
    })
    
    const nextNumber = parseInt(configObj.venta_numero_siguiente || 1)
    const prefix = configObj.venta_prefijo || 'FAC-'
    const invoiceNumber = `${prefix}${nextNumber.toString().padStart(6, '0')}`
    
    // Actualizar el siguiente número
    await connection.query(
      "UPDATE configuracion SET valor = ? WHERE clave = 'venta_numero_siguiente'",
      [(nextNumber + 1).toString()]
    )
    
    return invoiceNumber
  } catch (error) {
    console.error("Error al generar número de factura:", error)
    throw error
  }
}

// Obtener todas las ventas con filtros
export const getSales = async (req, res) => {
  try {
    const { 
      cliente = "", 
      estado = "", 
      fechaInicio = "", 
      fechaFin = "", 
      limit = 50, 
      offset = 0 
    } = req.query

    let query = `
      SELECT 
        v.id,
        v.numero_factura,
        v.fecha_venta,
        v.subtotal,
        v.descuento,
        v.total,
        v.tipo_pago,
        v.estado,
        v.observaciones,
        v.fecha_creacion,
        c.nombre as cliente_nombre,
        u.nombre as usuario_nombre,
        COUNT(dv.id) as total_items
      FROM ventas v
      JOIN clientes c ON v.cliente_id = c.id
      JOIN usuarios u ON v.usuario_id = u.id
      LEFT JOIN detalles_ventas dv ON v.id = dv.venta_id
      WHERE 1=1
    `

    const queryParams = []

    // Filtros
    if (cliente) {
      query += ` AND c.nombre LIKE ?`
      queryParams.push(`%${cliente}%`)
    }

    if (estado) {
      query += ` AND v.estado = ?`
      queryParams.push(estado)
    }

    if (fechaInicio) {
      query += ` AND DATE(v.fecha_venta) >= ?`
      queryParams.push(fechaInicio)
    }

    if (fechaFin) {
      query += ` AND DATE(v.fecha_venta) <= ?`
      queryParams.push(fechaFin)
    }

    query += ` GROUP BY v.id ORDER BY v.fecha_venta DESC, v.id DESC LIMIT ? OFFSET ?`
    queryParams.push(parseInt(limit), parseInt(offset))

    const [sales] = await pool.query(query, queryParams)
    
    // Convertir fechas a ISO
    const salesWithISODate = sales.map(sale => ({
      ...sale,
      fecha_venta: sale.fecha_venta.toISOString().split('T')[0],
      fecha_creacion: sale.fecha_creacion.toISOString()
    }))

    res.status(200).json(salesWithISODate)
  } catch (error) {
    console.error("Error al obtener ventas:", error)
    res.status(500).json({ message: "Error al obtener ventas" })
  }
}

// Obtener una venta por ID con sus detalles
export const getSaleById = async (req, res) => {
  try {
    const { id } = req.params

    // Obtener datos principales de la venta
    const [sales] = await pool.query(`
      SELECT 
        v.id,
        v.numero_factura,
        v.cliente_id,
        v.fecha_venta,
        v.subtotal,
        v.descuento,
        v.total,
        v.tipo_pago,
        v.estado,
        v.observaciones,
        v.fecha_creacion,
        c.nombre as cliente_nombre,
        c.telefono as cliente_telefono,
        c.email as cliente_email,
        c.direccion as cliente_direccion,
        c.cuit as cliente_cuit,
        u.nombre as usuario_nombre
      FROM ventas v
      JOIN clientes c ON v.cliente_id = c.id
      JOIN usuarios u ON v.usuario_id = u.id
      WHERE v.id = ?
    `, [id])

    if (sales.length === 0) {
      return res.status(404).json({ message: "Venta no encontrada" })
    }

    // Obtener detalles de la venta
    const [details] = await pool.query(`
      SELECT 
        dv.id,
        dv.producto_id,
        dv.cantidad,
        dv.precio_unitario,
        dv.subtotal,
        p.codigo as producto_codigo,
        p.nombre as producto_nombre,
        p.marca as producto_marca
      FROM detalles_ventas dv
      JOIN productos p ON dv.producto_id = p.id
      WHERE dv.venta_id = ?
      ORDER BY dv.id
    `, [id])

    const sale = {
      ...sales[0],
      fecha_venta: sales[0].fecha_venta.toISOString().split('T')[0],
      fecha_creacion: sales[0].fecha_creacion.toISOString(),
      detalles: details
    }

    res.status(200).json(sale)
  } catch (error) {
    console.error("Error al obtener venta:", error)
    res.status(500).json({ message: "Error al obtener venta" })
  }
}

// Crear una nueva venta
export const createSale = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const { 
      clienteId, 
      fechaVenta, 
      tipoPago = 'efectivo',
      descuento = 0, 
      observaciones = "", 
      detalles 
    } = req.body

    // Validar que hay detalles
    if (!detalles || detalles.length === 0) {
      await connection.rollback()
      return res.status(400).json({ message: "La venta debe tener al menos un producto" })
    }

    // Validar que el cliente existe
    const [client] = await connection.query(
      "SELECT id FROM clientes WHERE id = ? AND activo = TRUE", 
      [clienteId]
    )
    if (client.length === 0) {
      await connection.rollback()
      return res.status(400).json({ message: "Cliente no encontrado" })
    }

    // Generar número de factura
    const numeroFactura = await generateInvoiceNumber(connection)

    // Calcular totales
    let subtotal = 0
    for (const detalle of detalles) {
      const itemSubtotal = detalle.cantidad * detalle.precioUnitario
      subtotal += itemSubtotal
    }

    const total = subtotal - (descuento || 0)

    // Insertar venta
    const [saleResult] = await connection.query(`
      INSERT INTO ventas (
        numero_factura, cliente_id, usuario_id, fecha_venta, 
        subtotal, descuento, total, tipo_pago, observaciones
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [numeroFactura, clienteId, req.user.id, fechaVenta, subtotal, descuento, total, tipoPago, observaciones])

    const ventaId = saleResult.insertId

    // Insertar detalles y actualizar stock
    for (const detalle of detalles) {
      const { productoId, cantidad, precioUnitario } = detalle
      const itemSubtotal = cantidad * precioUnitario

      // Validar que el producto existe
      const [product] = await connection.query(
        "SELECT id, stock FROM productos WHERE id = ? AND activo = TRUE", 
        [productoId]
      )
      if (product.length === 0) {
        await connection.rollback()
        return res.status(400).json({ 
          message: `Producto con ID ${productoId} no encontrado` 
        })
      }

      // Validar stock disponible
      if (product[0].stock < cantidad) {
        await connection.rollback()
        return res.status(400).json({ 
          message: `Stock insuficiente para el producto ID ${productoId}` 
        })
      }

      // Insertar detalle de venta
      await connection.query(`
        INSERT INTO detalles_ventas (
          venta_id, producto_id, cantidad, precio_unitario, subtotal
        ) VALUES (?, ?, ?, ?, ?)
      `, [ventaId, productoId, cantidad, precioUnitario, itemSubtotal])

      // Actualizar stock del producto
      const nuevoStock = product[0].stock - cantidad
      await connection.query(
        "UPDATE productos SET stock = ? WHERE id = ?",
        [nuevoStock, productoId]
      )

      // Crear movimiento de stock
      await connection.query(`
        INSERT INTO movimientos_stock (
          producto_id, usuario_id, tipo, cantidad, 
          stock_anterior, stock_nuevo, motivo
        ) VALUES (?, ?, 'salida', ?, ?, ?, ?)
      `, [
        productoId, 
        req.user.id, 
        cantidad, 
        product[0].stock, 
        nuevoStock, 
        `Venta ${numeroFactura}`
      ])
    }

    await connection.commit()

    res.status(201).json({
      message: "Venta creada exitosamente",
      id: ventaId,
      numeroFactura
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al crear venta:", error)
    res.status(500).json({ message: "Error al crear venta" })
  } finally {
    connection.release()
  }
}

// Anular una venta
export const cancelSale = async (req, res) => {
  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const { id } = req.params
    const { motivo = "Venta anulada" } = req.body

    // Verificar que la venta existe y no está anulada
    const [existing] = await connection.query(
      "SELECT id, estado, numero_factura FROM ventas WHERE id = ?", 
      [id]
    )
    if (existing.length === 0) {
      await connection.rollback()
      return res.status(404).json({ message: "Venta no encontrada" })
    }

    if (existing[0].estado === 'anulada') {
      await connection.rollback()
      return res.status(400).json({ 
        message: "Esta venta ya fue anulada" 
      })
    }

    // Obtener detalles de la venta para restaurar stock
    const [details] = await connection.query(
      "SELECT producto_id, cantidad FROM detalles_ventas WHERE venta_id = ?",
      [id]
    )

    // Restaurar stock para cada producto
    for (const detail of details) {
      // Obtener stock actual
      const [product] = await connection.query(
        "SELECT stock FROM productos WHERE id = ?",
        [detail.producto_id]
      )
      
      if (product.length > 0) {
        const stockActual = product[0].stock
        const nuevoStock = stockActual + detail.cantidad
        
        // Actualizar stock
        await connection.query(
          "UPDATE productos SET stock = ? WHERE id = ?",
          [nuevoStock, detail.producto_id]
        )
        
        // Registrar movimiento de stock
        await connection.query(`
          INSERT INTO movimientos_stock (
            producto_id, usuario_id, tipo, cantidad, 
            stock_anterior, stock_nuevo, motivo
          ) VALUES (?, ?, 'entrada', ?, ?, ?, ?)
        `, [
          detail.producto_id, 
          req.user.id, 
          detail.cantidad, 
          stockActual, 
          nuevoStock, 
          `Anulación de venta ${existing[0].numero_factura}`
        ])
      }
    }

    // Actualizar estado a anulada
    await connection.query(
      "UPDATE ventas SET estado = 'anulada', observaciones = CONCAT(observaciones, ' | ', ?) WHERE id = ?", 
      [`ANULADA: ${motivo}`, id]
    )

    await connection.commit()

    res.status(200).json({ message: "Venta anulada exitosamente" })
  } catch (error) {
    await connection.rollback()
    console.error("Error al anular venta:", error)
    res.status(500).json({ message: "Error al anular venta" })
  } finally {
    connection.release()
  }
}

// Obtener estadísticas de ventas
export const getSalesStats = async (req, res) => {
  try {
    const { fechaInicio = "", fechaFin = "" } = req.query

    let whereClause = "WHERE estado = 'completada'"
    const queryParams = []

    if (fechaInicio) {
      whereClause += " AND DATE(fecha_venta) >= ?"
      queryParams.push(fechaInicio)
    }

    if (fechaFin) {
      whereClause += " AND DATE(fecha_venta) <= ?"
      queryParams.push(fechaFin)
    }

    // Total de ventas
    const [totalCount] = await pool.query(
      `SELECT COUNT(*) as total FROM ventas ${whereClause}`,
      queryParams
    )

    // Monto total
    const [totalAmount] = await pool.query(
      `SELECT SUM(total) as total FROM ventas ${whereClause}`,
      queryParams
    )

    // Ventas por día (últimos 30 días)
    const [salesByDay] = await pool.query(`
      SELECT 
        DATE(fecha_venta) as fecha,
        COUNT(*) as cantidad,
        SUM(total) as total
      FROM ventas
      ${whereClause}
      GROUP BY DATE(fecha_venta)
      ORDER BY fecha DESC
      LIMIT 30
    `, queryParams)

    // Productos más vendidos
    const [topProducts] = await pool.query(`
      SELECT 
        p.id,
        p.codigo,
        p.nombre,
        SUM(dv.cantidad) as cantidad_total,
        SUM(dv.subtotal) as monto_total
      FROM detalles_ventas dv
      JOIN productos p ON dv.producto_id = p.id
      JOIN ventas v ON dv.venta_id = v.id
      ${whereClause}
      GROUP BY p.id
      ORDER BY cantidad_total DESC
      LIMIT 10
    `, queryParams)

    // Ventas por tipo de pago
    const [salesByPaymentType] = await pool.query(`
      SELECT 
        tipo_pago,
        COUNT(*) as cantidad,
        SUM(total) as total
      FROM ventas
      ${whereClause}
      GROUP BY tipo_pago
    `, queryParams)

    res.status(200).json({
      totalVentas: totalCount[0].total || 0,
      montoTotal: totalAmount[0].total || 0,
      ventasPorDia: salesByDay,
      productosTopVentas: topProducts,
      ventasPorTipoPago: salesByPaymentType
    })
  } catch (error) {
    console.error("Error al obtener estadísticas de ventas:", error)
    res.status(500).json({ message: "Error al obtener estadísticas de ventas" })
  }
}

// Obtener ventas por cliente
export const getSalesByClient = async (req, res) => {
  try {
    const { clientId } = req.params
    const { limit = 20 } = req.query

    const [sales] = await pool.query(`
      SELECT 
        v.id,
        v.numero_factura,
        v.fecha_venta,
        v.total,
        v.tipo_pago,
        v.estado,
        COUNT(dv.id) as total_items
      FROM ventas v
      LEFT JOIN detalles_ventas dv ON v.id = dv.venta_id
      WHERE v.cliente_id = ?
      GROUP BY v.id
      ORDER BY v.fecha_venta DESC
      LIMIT ?
    `, [clientId, parseInt(limit)])

    // Convertir fechas a ISO
    const salesWithISODate = sales.map(sale => ({
      ...sale,
      fecha_venta: sale.fecha_venta.toISOString().split('T')[0]
    }))

    res.status(200).json(salesWithISODate)
  } catch (error) {
    console.error("Error al obtener ventas del cliente:", error)
    res.status(500).json({ message: "Error al obtener ventas del cliente" })
  }
}