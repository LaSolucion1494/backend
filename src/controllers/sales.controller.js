// sales.controller.js - VERSIÓN CORREGIDA PARA REPORTES CON PAGINACIÓN Y VENTAS PENDIENTES
import pool from "../db.js"
import { validationResult } from "express-validator"

// VALORES HARDCODEADOS PARA CUENTA CORRIENTE
const CUENTA_CORRIENTE_CONFIG = {
  activa: true,
  limite_credito_default: 50000,
}

// Función para obtener datos de la empresa desde la configuración
const getCompanyDataFromConfig = async (connection) => {
  try {
    const [config] = await connection.query(`
      SELECT clave, valor FROM configuracion 
      WHERE clave IN (
        'empresa_nombre', 'empresa_telefono', 'empresa_direccion', 'empresa_cuit', 
        'empresa_email', 'empresa_condicion_iva', 'empresa_inicio_actividades',
        'iva', 'ingresos_brutos'
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
      condicion_iva: configObj.empresa_condicion_iva || "RESPONSABLE INSCRIPTO",
      inicio_actividades: configObj.empresa_inicio_actividades || "01/05/1998",
      iva: configObj.iva || "21",
      ingresos_brutos: configObj.ingresos_brutos || "0",
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
      iva: "21",
      ingresos_brutos: "0",
    }
  }
}

// Función para generar el próximo número de factura
const generateInvoiceNumber = async (connection) => {
  try {
    const [config] = await connection.query(`
      SELECT clave, valor FROM configuracion 
      WHERE clave IN ('venta_numero_siguiente', 'venta_prefijo')
      FOR UPDATE
    `)

    if (config.length === 0) {
      throw new Error("No se encontró configuración de numeración de facturas")
    }

    const configObj = {}
    config.forEach((item) => {
      configObj[item.clave] = item.valor
    })

    if (!configObj.venta_numero_siguiente) {
      throw new Error("No se encontró el próximo número de factura en la configuración")
    }

    const nextNumber = Number.parseInt(configObj.venta_numero_siguiente)
    if (isNaN(nextNumber) || nextNumber < 1) {
      throw new Error(`Número de factura inválido en configuración: ${configObj.venta_numero_siguiente}`)
    }

    const prefix = configObj.venta_prefijo || "FAC-"
    const invoiceNumber = `${prefix}${nextNumber.toString().padStart(6, "0")}`

    const [updateResult] = await connection.query(
      "UPDATE configuracion SET valor = ? WHERE clave = 'venta_numero_siguiente'",
      [(nextNumber + 1).toString()],
    )

    if (updateResult.affectedRows === 0) {
      throw new Error("No se pudo actualizar el contador de facturas")
    }

    return invoiceNumber
  } catch (error) {
    console.error("Error al generar número de factura:", error)
    throw new Error(`Error al generar número de factura: ${error.message}`)
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

    const { clienteId, productos, descuento = 0, interes = 0, observaciones = "", pagos = [], fechaVenta } = req.body

    if (!productos || productos.length === 0) {
      await connection.rollback()
      return res.status(400).json({ message: "Debe incluir al menos un producto" })
    }

    if (!pagos || pagos.length === 0) {
      await connection.rollback()
      return res.status(400).json({ message: "Debe incluir al menos un método de pago" })
    }

    const empresaDatos = await getCompanyDataFromConfig(connection)

    const [clienteData] = await connection.query(
      `SELECT 
        c.id, 
        c.nombre, 
        c.tiene_cuenta_corriente,
        c.limite_credito,
        c.saldo_cuenta_corriente
      FROM clientes c
      WHERE c.id = ? AND c.activo = TRUE`,
      [clienteId],
    )

    if (clienteData.length === 0) {
      await connection.rollback()
      return res.status(404).json({ message: "Cliente no encontrado" })
    }

    const cliente = clienteData[0]

    let subtotal = 0
    const productsToProcess = [] // Almacena productos con su estado de stock
    let shouldBePending = false // Flag para determinar el estado inicial de la venta

    for (const item of productos) {
      const [producto] = await connection.query(
        "SELECT id, nombre, stock, precio_venta FROM productos WHERE id = ? AND activo = TRUE FOR UPDATE", // Bloquear fila para verificación de stock
        [item.productoId],
      )

      if (producto.length === 0) {
        await connection.rollback()
        return res.status(404).json({ message: `Producto con ID ${item.productoId} no encontrado` })
      }

      const prod = producto[0]

      // Verificar stock para determinar el estado inicial de la venta
      const hasEnoughStock = prod.stock >= item.cantidad
      if (!hasEnoughStock) {
        shouldBePending = true // Si algún producto no tiene stock, toda la venta se vuelve pendiente
      }

      const precioUnitario = Number.parseFloat(item.precioUnitario || prod.precio_venta)
      const cantidad = Number.parseInt(item.cantidad)
      const subtotalItem = precioUnitario * cantidad
      const discountPercentage = Number.parseFloat(item.discount_percentage || 0)

      productsToProcess.push({
        ...item,
        nombre: prod.nombre,
        precioUnitario,
        cantidad,
        subtotalItem,
        discount_percentage: discountPercentage,
        hasEnoughStock: hasEnoughStock, // Almacenar si tiene suficiente stock
        currentStock: prod.stock, // Almacenar stock actual para el log
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
        message: `El total de pagos ($${totalPagos.toFixed(2)}) no coincide con el total de la venta ($${total.toFixed(2)})`,
      })
    }

    const pagoCuentaCorriente = pagos.find((pago) => pago.tipo === "cuenta_corriente")
    const tieneCuentaCorriente = !!pagoCuentaCorriente

    if (tieneCuentaCorriente) {
      if (!CUENTA_CORRIENTE_CONFIG.activa) {
        await connection.rollback()
        return res.status(400).json({ message: "La funcionalidad de cuenta corriente no está disponible" })
      }

      if (!cliente.tiene_cuenta_corriente) {
        await connection.rollback()
        return res.status(400).json({ message: "El cliente no tiene cuenta corriente habilitada" })
      }

      const montoCuentaCorriente = Number.parseFloat(pagoCuentaCorriente.monto)

      const [saldoActualResult] = await connection.query(
        "SELECT saldo_cuenta_corriente FROM clientes WHERE id = ? FOR UPDATE",
        [clienteId],
      )

      if (saldoActualResult.length === 0) {
        await connection.rollback()
        return res.status(400).json({ message: "Cliente no encontrado" })
      }

      const saldoActual = Number.parseFloat(saldoActualResult[0].saldo_cuenta_corriente)
      const nuevoSaldo = saldoActual + montoCuentaCorriente

      if (cliente.limite_credito && nuevoSaldo > Number.parseFloat(cliente.limite_credito)) {
        const disponible = Number.parseFloat(cliente.limite_credito) - saldoActual
        await connection.rollback()
        return res.status(400).json({
          message: `El monto excede el límite de crédito disponible. Límite: $${Number.parseFloat(cliente.limite_credito).toFixed(2)}, Saldo actual: $${saldoActual.toFixed(2)}, Disponible: $${disponible.toFixed(2)}`,
        })
      }
    }

    const numeroFactura = await generateInvoiceNumber(connection)

    if (!numeroFactura) {
      await connection.rollback()
      return res.status(500).json({ message: "Error al generar número de factura" })
    }

    // Determinar el estado inicial de la venta
    const initialSaleStatus = shouldBePending ? "pendiente" : "completada"

    const [ventaResult] = await connection.query(
      `
      INSERT INTO ventas (
        numero_factura, cliente_id, usuario_id, fecha_venta,
        subtotal, descuento, interes, total, observaciones,
        tiene_cuenta_corriente, empresa_datos, estado
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        numeroFactura,
        clienteId,
        req.user.id,
        fechaVenta,
        subtotal,
        descuentoNum,
        interesNum,
        total,
        observaciones,
        tieneCuentaCorriente,
        JSON.stringify(empresaDatos),
        initialSaleStatus, // Usar el estado determinado
      ],
    )

    const ventaId = ventaResult.insertId

    for (const item of productsToProcess) {
      const discountPercentage = Number.parseFloat(item.discount_percentage || 0)
      let cantidadEntregada = 0

      if (initialSaleStatus === "completada") {
        // Si la venta se crea como 'completada', se considera que los productos se entregan inmediatamente
        cantidadEntregada = item.cantidad

        // Decrementar stock del producto
        const newStock = item.currentStock - item.cantidad
        await connection.query("UPDATE productos SET stock = ? WHERE id = ?", [newStock, item.productoId])

        // Registrar movimiento de stock de salida
        await connection.query(
          `
          INSERT INTO movimientos_stock (
            producto_id, usuario_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo
          ) VALUES (?, ?, 'salida', ?, ?, ?, ?)
        `,
          [
            item.productoId,
            req.user.id,
            item.cantidad,
            item.currentStock,
            newStock,
            `Venta completada ${numeroFactura} - Entrega inmediata`,
          ],
        )
      }
      // Si initialSaleStatus es 'pendiente', cantidadEntregada permanece en 0 y el stock no se toca.

      await connection.query(
        "INSERT INTO detalles_ventas (venta_id, producto_id, cantidad, precio_unitario, subtotal, discount_percentage, cantidad_entregada) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          ventaId,
          item.productoId,
          item.cantidad,
          item.precioUnitario,
          item.subtotalItem,
          discountPercentage,
          cantidadEntregada,
        ],
      )
    }

    let movimientoCuentaId = null

    for (const pago of pagos) {
      let movimientoId = null

      if (pago.tipo === "cuenta_corriente") {
        const montoCuentaCorriente = Number.parseFloat(pago.monto)

        const [saldoActualResult] = await connection.query(
          "SELECT saldo_cuenta_corriente FROM clientes WHERE id = ? FOR UPDATE",
          [clienteId],
        )

        const saldoAnterior = Number.parseFloat(saldoActualResult[0].saldo_cuenta_corriente)
        const nuevoSaldo = saldoAnterior + montoCuentaCorriente

        const [movimientoResult] = await connection.query(
          `
          INSERT INTO movimientos_cuenta_corriente (
            cliente_id, usuario_id, tipo, concepto,
            monto, saldo_anterior, saldo_nuevo, referencia_id, referencia_tipo,
            numero_referencia, descripcion
          ) VALUES (?, ?, 'debito', 'venta', ?, ?, ?, ?, 'venta', ?, ?)
        `,
          [
            clienteId,
            req.user.id,
            montoCuentaCorriente,
            saldoAnterior,
            nuevoSaldo,
            ventaId,
            numeroFactura,
            `Venta ${numeroFactura} - ${cliente.nombre}`,
          ],
        )

        movimientoId = movimientoResult.insertId
        movimientoCuentaId = movimientoId

        await connection.query("UPDATE clientes SET saldo_cuenta_corriente = ROUND(?, 2) WHERE id = ?", [
          nuevoSaldo,
          clienteId,
        ])

        await connection.query("UPDATE ventas SET movimiento_cuenta_id = ? WHERE id = ?", [movimientoId, ventaId])
      }

      await connection.query(
        "INSERT INTO venta_pagos (venta_id, tipo_pago, monto, descripcion, movimiento_cuenta_id) VALUES (?, ?, ?, ?, ?)",
        [ventaId, pago.tipo, Number.parseFloat(pago.monto), pago.descripcion || "", movimientoId],
      )
    }

    await connection.commit()

    res.status(201).json({
      message: `Venta creada exitosamente como ${initialSaleStatus}`,
      data: {
        id: ventaId,
        numeroFactura: numeroFactura,
        total,
        tieneCuentaCorriente,
        movimientoCuentaId,
        empresaDatos,
        estado: initialSaleStatus, // Confirmar el estado inicial
      },
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al crear venta:", error)
    res.status(500).json({
      message: error.message || "Error al crear venta",
      details: error.stack,
    })
  } finally {
    connection.release()
  }
}

// Obtener una venta por ID incluyendo datos de empresa
export const getSaleById = async (req, res) => {
  try {
    const { id } = req.params

    const [sales] = await pool.query(
      `
      SELECT 
        v.*,
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
    `,
      [id],
    )

    if (sales.length === 0) {
      return res.status(404).json({ message: "Venta no encontrada" })
    }

    const sale = sales[0]

    let empresaDatos = null
    if (sale.empresa_datos) {
      try {
        empresaDatos = JSON.parse(sale.empresa_datos)
      } catch (error) {
        console.error("Error al parsear datos de empresa:", error)
        const connection = await pool.getConnection()
        try {
          empresaDatos = await getCompanyDataFromConfig(connection)
        } finally {
          connection.release()
        }
      }
    } else {
      const connection = await pool.getConnection()
      try {
        empresaDatos = await getCompanyDataFromConfig(connection)
      } finally {
        connection.release()
      }
    }

    const [details] = await pool.query(
      `
      SELECT 
        dv.*,
        p.nombre as producto_nombre,
        p.codigo as producto_codigo,
        p.marca as producto_marca,
        p.stock as producto_stock_actual -- Incluir stock actual del producto
      FROM detalles_ventas dv
      JOIN productos p ON dv.producto_id = p.id
      WHERE dv.venta_id = ?
      ORDER BY dv.id
    `,
      [id],
    )

    const [payments] = await pool.query(
      `
      SELECT 
        vp.*,
        mcc.numero_referencia as movimiento_numero,
        mcc.descripcion as movimiento_descripcion
      FROM venta_pagos vp
      LEFT JOIN movimientos_cuenta_corriente mcc ON vp.movimiento_cuenta_id = mcc.id
      WHERE vp.venta_id = ? 
      ORDER BY vp.id
    `,
      [id],
    )

    const saleData = {
      ...sale,
      fecha_venta: sale.fecha_venta.toISOString().split("T")[0],
      fecha_creacion: sale.fecha_creacion.toISOString(),
      fecha_actualizacion: sale.fecha_actualizacion.toISOString(),
      empresa_datos: empresaDatos,
      detalles: details.map((detail) => ({
        ...detail,
        fecha_creacion: detail.fecha_creacion.toISOString(),
      })),
      pagos: payments.map((payment) => ({
        ...payment,
        fecha_creacion: payment.fecha_creacion.toISOString(),
      })),
    }

    res.status(200).json(saleData)
  } catch (error) {
    console.error("Error al obtener venta:", error)
    res.status(500).json({ message: "Error al obtener venta" })
  }
}

// ACTUALIZADO: Obtener ventas para reportes CON PAGINACIÓN
export const getSales = async (req, res) => {
  try {
    console.log("getSales called with query:", req.query)

    const {
      fechaInicio = "",
      fechaFin = "",
      cliente = "",
      numeroFactura = "",
      estado = "todos",
      tipoPago = "todos",
      limit = 10,
      offset = 0,
    } = req.query

    let baseQuery = `
      FROM ventas v
      JOIN clientes c ON v.cliente_id = c.id
      JOIN usuarios u ON v.usuario_id = u.id
      WHERE 1=1
    `

    const queryParams = []

    if (fechaInicio) {
      baseQuery += ` AND DATE(v.fecha_venta) >= ?`
      queryParams.push(fechaInicio)
    }

    if (fechaFin) {
      baseQuery += ` AND DATE(v.fecha_venta) <= ?`
      queryParams.push(fechaFin)
    }

    if (cliente) {
      baseQuery += ` AND c.nombre LIKE ?`
      queryParams.push(`%${cliente}%`)
    }

    if (numeroFactura) {
      baseQuery += ` AND v.numero_factura LIKE ?`
      queryParams.push(`%${numeroFactura}%`)
    }

    if (estado !== "todos") {
      baseQuery += ` AND v.estado = ?`
      queryParams.push(estado)
    }

    // Filtro por tipo de pago
    if (tipoPago !== "todos") {
      if (tipoPago === "varios") {
        baseQuery += ` AND v.id IN (
          SELECT venta_id FROM venta_pagos 
          GROUP BY venta_id 
          HAVING COUNT(DISTINCT tipo_pago) > 1
        )`
      } else {
        baseQuery += ` AND v.id IN (
          SELECT venta_id FROM venta_pagos 
          WHERE tipo_pago = ?
        )`
        queryParams.push(tipoPago)
      }
    }

    // Consulta de conteo
    const countQuery = `SELECT COUNT(*) as total ${baseQuery}`
    const [[{ total }]] = await pool.query(countQuery, queryParams)

    // Consulta de datos con paginación
    const dataQuery = `
      SELECT 
        v.id,
        v.numero_factura,
        v.fecha_venta,
        v.subtotal,
        v.descuento,
        v.interes,
        v.total,
        v.estado,
        v.observaciones,
        v.tiene_cuenta_corriente,
        v.fecha_creacion,
        c.nombre as cliente_nombre,
        u.nombre as usuario_nombre
      ${baseQuery}
      ORDER BY v.fecha_venta DESC, v.id DESC
      LIMIT ? OFFSET ?
    `
    const finalDataParams = [...queryParams, Number.parseInt(limit), Number.parseInt(offset)]
    const [sales] = await pool.query(dataQuery, finalDataParams)

    console.log("Found sales:", sales.length)

    const salesWithISODate = sales.map((sale) => ({
      ...sale,
      fecha_venta: sale.fecha_venta.toISOString().split("T")[0],
      fecha_creacion: sale.fecha_creacion.toISOString(),
    }))

    console.log("Returning sales data with pagination")
    res.status(200).json({
      success: true,
      data: salesWithISODate,
      pagination: {
        totalItems: total,
        totalPages: Math.ceil(total / limit),
        currentPage: Math.floor(offset / limit) + 1,
        itemsPerPage: Number.parseInt(limit),
      },
    })
  } catch (error) {
    console.error("Error al obtener ventas:", error)
    res.status(500).json({
      success: false,
      message: "Error al obtener ventas",
      error: error.message,
    })
  }
}

// CORREGIDO: Obtener estadísticas de ventas
export const getSalesStats = async (req, res) => {
  try {
    console.log("getSalesStats called with query:", req.query)

    const { fechaInicio = "", fechaFin = "" } = req.query

    let whereClause = "WHERE 1=1" // Cambiado para incluir todos los estados por defecto
    const queryParams = []

    if (fechaInicio) {
      whereClause += " AND DATE(v.fecha_venta) >= ?"
      queryParams.push(fechaInicio)
    }

    if (fechaFin) {
      whereClause += " AND DATE(v.fecha_venta) <= ?"
      queryParams.push(fechaFin)
    }

    console.log("Stats where clause:", whereClause)
    console.log("Stats params:", queryParams)

    // Estadísticas generales
    const [generalStats] = await pool.query(
      `
      SELECT 
        COUNT(*) as total_ventas,
        SUM(CASE WHEN v.estado = 'completada' THEN v.total ELSE 0 END) as total_facturado,
        AVG(CASE WHEN v.estado = 'completada' THEN v.total ELSE NULL END) as promedio_venta,
        SUM(CASE WHEN v.tiene_cuenta_corriente AND v.estado = 'completada' THEN 1 ELSE 0 END) as ventas_cuenta_corriente,
        SUM(CASE WHEN v.tiene_cuenta_corriente AND v.estado = 'completada' THEN v.total ELSE 0 END) as total_cuenta_corriente,
        SUM(CASE WHEN v.estado = 'completada' THEN 1 ELSE 0 END) as ventas_completadas,
        SUM(CASE WHEN v.estado = 'anulada' THEN 1 ELSE 0 END) as ventas_anuladas,
        SUM(CASE WHEN v.estado = 'pendiente' THEN 1 ELSE 0 END) as ventas_pendientes
      FROM ventas v
      ${whereClause}
    `,
      queryParams,
    )

    // Ventas por día (solo completadas para facturado)
    const [salesByDay] = await pool.query(
      `
      SELECT 
        DATE(v.fecha_venta) as fecha,
        COUNT(*) as cantidad_ventas,
        SUM(CASE WHEN v.estado = 'completada' THEN v.total ELSE 0 END) as total_dia
      FROM ventas v
      ${whereClause}
      GROUP BY DATE(v.fecha_venta)
      ORDER BY fecha DESC
      LIMIT 30
    `,
      queryParams,
    )

    // Top clientes (solo ventas completadas)
    const [topClients] = await pool.query(
      `
      SELECT 
        c.id,
        c.nombre,
        COUNT(v.id) as cantidad_compras,
        SUM(v.total) as total_comprado
      FROM ventas v
      JOIN clientes c ON v.cliente_id = c.id
      ${whereClause} AND v.estado = 'completada'
      GROUP BY c.id
      ORDER BY total_comprado DESC
      LIMIT 10
    `,
      queryParams,
    )

    // Métodos de pago (solo ventas completadas)
    const [paymentMethods] = await pool.query(
      `
      SELECT 
        vp.tipo_pago,
        COUNT(vp.id) as cantidad_usos,
        SUM(vp.monto) as total_monto
      FROM venta_pagos vp
      JOIN ventas v ON vp.venta_id = v.id
      ${whereClause.replace("WHERE", "WHERE")} AND v.estado = 'completada'
      GROUP BY vp.tipo_pago
      ORDER BY total_monto DESC
    `,
      queryParams,
    )

    const stats = {
      estadisticas_generales: generalStats[0],
      ventas_por_dia: salesByDay.map((day) => ({
        ...day,
        fecha: day.fecha.toISOString().split("T")[0],
      })),
      top_clientes: topClients,
      metodos_pago: paymentMethods,
    }

    console.log("Returning stats:", stats)
    res.status(200).json(stats)
  } catch (error) {
    console.error("Error al obtener estadísticas:", error)
    res.status(500).json({
      success: false,
      message: "Error al obtener estadísticas",
      error: error.message,
    })
  }
}

// Anular venta
export const cancelSale = async (req, res) => {
  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const { id } = req.params
    const { motivo = "" } = req.body

    const [sales] = await connection.query("SELECT * FROM ventas WHERE id = ? AND estado != 'anulada'", [id])

    if (sales.length === 0) {
      await connection.rollback()
      return res.status(404).json({ message: "Venta no encontrada o ya está anulada" })
    }

    const sale = sales[0]

    // Solo revertir stock si la venta estaba completada
    if (sale.estado === "completada") {
      const [details] = await connection.query("SELECT * FROM detalles_ventas WHERE venta_id = ?", [id])

      for (const detail of details) {
        // Solo revertir la cantidad que fue entregada (y por lo tanto, decrementó el stock)
        const cantidadARevertir = detail.cantidad_entregada

        if (cantidadARevertir > 0) {
          const [stockActual] = await connection.query("SELECT stock FROM productos WHERE id = ?", [detail.producto_id])

          const nuevoStock = stockActual[0].stock + cantidadARevertir

          await connection.query("UPDATE productos SET stock = ? WHERE id = ?", [nuevoStock, detail.producto_id])

          await connection.query(
            `
            INSERT INTO movimientos_stock (
              producto_id, usuario_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo
            ) VALUES (?, ?, 'entrada', ?, ?, ?, ?)
          `,
            [
              detail.producto_id,
              req.user.id,
              cantidadARevertir,
              stockActual[0].stock,
              nuevoStock,
              `Anulación venta ${sale.numero_factura} - ${motivo} (reversión de ${cantidadARevertir} unidades entregadas)`,
            ],
          )
        }
      }
    }

    if (sale.tiene_cuenta_corriente) {
      const [pagosCuentaCorriente] = await connection.query(
        `
        SELECT vp.*, mcc.* 
        FROM venta_pagos vp
        JOIN movimientos_cuenta_corriente mcc ON vp.movimiento_cuenta_id = mcc.id
        WHERE vp.venta_id = ? AND vp.tipo_pago = 'cuenta_corriente'
      `,
        [id],
      )

      for (const pago of pagosCuentaCorriente) {
        const [clienteInfo] = await connection.query(
          "SELECT saldo_cuenta_corriente FROM clientes WHERE id = ? FOR UPDATE",
          [pago.cliente_id],
        )

        if (clienteInfo.length > 0) {
          const saldoAnterior = Number.parseFloat(clienteInfo[0].saldo_cuenta_corriente)
          const montoRevertir = Number.parseFloat(pago.monto)
          const nuevoSaldo = Math.max(0, saldoAnterior - montoRevertir)

          await connection.query(
            `
            INSERT INTO movimientos_cuenta_corriente (
              cliente_id, usuario_id, tipo, concepto,
              monto, saldo_anterior, saldo_nuevo, referencia_id, referencia_tipo,
              numero_referencia, descripcion
            ) VALUES (?, ?, 'credito', 'nota_credito', ?, ?, ?, ?, 'anulacion_venta', ?, ?)
          `,
            [
              sale.cliente_id,
              req.user.id,
              montoRevertir,
              saldoAnterior,
              nuevoSaldo,
              id,
              sale.numero_factura,
              `Anulación venta ${sale.numero_factura} - ${motivo}`,
            ],
          )

          await connection.query("UPDATE clientes SET saldo_cuenta_corriente = ROUND(?, 2) WHERE id = ?", [
            nuevoSaldo,
            sale.cliente_id,
          ])
        }
      }
    }

    await connection.query(
      "UPDATE ventas SET estado = 'anulada', observaciones = CONCAT(COALESCE(observaciones, ''), ' - ANULADA: ', ?) WHERE id = ?",
      [motivo, id],
    )

    await connection.commit()

    res.status(200).json({
      message: "Venta anulada exitosamente",
      data: {
        id,
        numeroFactura: sale.numero_factura,
        motivo,
      },
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al anular venta:", error)
    res.status(500).json({ message: error.message || "Error al anular venta" })
  } finally {
    connection.release()
  }
}

// Obtener ventas por cliente CON PAGINACIÓN
export const getSalesByClient = async (req, res) => {
  try {
    const { clientId } = req.params
    const { limit = 10, offset = 0, estado = "todos" } = req.query

    const [client] = await pool.query("SELECT id, nombre FROM clientes WHERE id = ? AND activo = TRUE", [clientId])

    if (client.length === 0) {
      return res.status(404).json({ message: "Cliente no encontrado" })
    }

    let baseQuery = `
      FROM ventas v
      JOIN usuarios u ON v.usuario_id = u.id
      WHERE v.cliente_id = ?
    `

    const queryParams = [clientId]

    if (estado !== "todos") {
      baseQuery += ` AND v.estado = ?`
      queryParams.push(estado)
    }

    // Consulta de conteo
    const countQuery = `SELECT COUNT(*) as total ${baseQuery}`
    const [[{ total }]] = await pool.query(countQuery, queryParams)

    // Consulta de datos con paginación
    const dataQuery = `
      SELECT 
        v.id,
        v.numero_factura,
        v.fecha_venta,
        v.subtotal,
        v.descuento,
        v.interes,
        v.total,
        v.estado,
        v.observaciones,
        v.tiene_cuenta_corriente,
        v.fecha_creacion,
        u.nombre as usuario_nombre
      ${baseQuery}
      ORDER BY v.fecha_venta DESC, v.id DESC
      LIMIT ? OFFSET ?
    `
    const finalDataParams = [...queryParams, Number.parseInt(limit), Number.parseInt(offset)]
    const [sales] = await pool.query(dataQuery, finalDataParams)

    const salesWithISODate = sales.map((sale) => ({
      ...sale,
      fecha_venta: sale.fecha_venta.toISOString().split("T")[0],
      fecha_creacion: sale.fecha_creacion.toISOString(),
    }))

    res.status(200).json({
      success: true,
      cliente: client[0],
      data: salesWithISODate,
      pagination: {
        totalItems: total,
        totalPages: Math.ceil(total / limit),
        currentPage: Math.floor(offset / limit) + 1,
        itemsPerPage: Number.parseInt(limit),
      },
    })
  } catch (error) {
    console.error("Error al obtener ventas del cliente:", error)
    res.status(500).json({
      success: false,
      message: "Error al obtener ventas del cliente",
    })
  }
}

// Obtener resumen del día
export const getTodaySummary = async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0]

    const [summary] = await pool.query(
      `
      SELECT 
        COUNT(*) as total_ventas,
        SUM(CASE WHEN v.estado = 'completada' THEN v.total ELSE 0 END) as total_facturado,
        SUM(CASE WHEN v.tiene_cuenta_corriente AND v.estado = 'completada' THEN 1 ELSE 0 END) as ventas_cuenta_corriente,
        SUM(CASE WHEN v.tiene_cuenta_corriente AND v.estado = 'completada' THEN v.total ELSE 0 END) as total_cuenta_corriente,
        SUM(CASE WHEN v.estado = 'pendiente' THEN 1 ELSE 0 END) as ventas_pendientes_hoy
      FROM ventas v
      WHERE DATE(v.fecha_venta) = ?
    `, // Se incluyen ventas pendientes en el conteo total
      [today],
    )

    const [paymentMethods] = await pool.query(
      `
      SELECT 
        vp.tipo_pago,
        COUNT(vp.id) as cantidad,
        SUM(vp.monto) as total
      FROM venta_pagos vp
      JOIN ventas v ON vp.venta_id = v.id
      WHERE DATE(v.fecha_venta) = ? AND v.estado = 'completada'
      GROUP BY vp.tipo_pago
      ORDER BY total DESC
    `,
      [today],
    )

    const [topProducts] = await pool.query(
      `
      SELECT 
        p.id,
        p.nombre,
        p.codigo,
        SUM(dv.cantidad_entregada) as cantidad_vendida, -- Sumar por cantidad entregada
        SUM(dv.precio_unitario * dv.cantidad_entregada) as total_vendido -- Calcular total vendido por entregado
      FROM detalles_ventas dv
      JOIN ventas v ON dv.venta_id = v.id
      JOIN productos p ON dv.producto_id = p.id
      WHERE DATE(v.fecha_venta) = ? AND v.estado = 'completada' AND dv.cantidad_entregada > 0
      GROUP BY p.id
      ORDER BY cantidad_vendida DESC
      LIMIT 10
    `,
      [today],
    )

    const todaySummary = {
      resumen: summary[0],
      metodos_pago: paymentMethods,
      productos_mas_vendidos: topProducts,
    }

    res.status(200).json(todaySummary)
  } catch (error) {
    console.error("Error al obtener resumen del día:", error)
    res.status(500).json({ message: "Error al obtener resumen del día" })
  }
}

// Alias para compatibilidad con rutas existentes
export const getDailySummary = getTodaySummary

// Actualizar venta
export const updateSale = async (req, res) => {
  try {
    const { id } = req.params
    const { observaciones } = req.body

    const [result] = await pool.query("UPDATE ventas SET observaciones = ? WHERE id = ?", [observaciones, id])

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Venta no encontrada" })
    }

    res.status(200).json({
      message: "Venta actualizada exitosamente",
      data: { id, observaciones },
    })
  } catch (error) {
    console.error("Error al actualizar venta:", error)
    res.status(500).json({ message: "Error al actualizar venta" })
  }
}

// NUEVA FUNCIÓN: Entregar productos de una venta pendiente
export const deliverProducts = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const { id } = req.params // ID de la venta
    const { deliveries } = req.body // [{ detalleId, quantity }]

    const [saleResult] = await connection.query(
      "SELECT id, numero_factura, estado FROM ventas WHERE id = ? FOR UPDATE",
      [id],
    )

    if (saleResult.length === 0) {
      await connection.rollback()
      return res.status(404).json({ message: "Venta no encontrada" })
    }

    const sale = saleResult[0]
    let allProductsDelivered = true

    for (const delivery of deliveries) {
      const { detalleId, quantity } = delivery

      if (quantity <= 0) {
        continue // Ignorar entregas con cantidad cero o negativa
      }

      const [detailResult] = await connection.query(
        "SELECT id, producto_id, cantidad, cantidad_entregada FROM detalles_ventas WHERE id = ? AND venta_id = ? FOR UPDATE",
        [detalleId, id],
      )

      if (detailResult.length === 0) {
        await connection.rollback()
        return res.status(404).json({ message: `Detalle de venta con ID ${detalleId} no encontrado` })
      }

      const detail = detailResult[0]
      const remainingToDeliver = detail.cantidad - detail.cantidad_entregada

      if (quantity > remainingToDeliver) {
        await connection.rollback()
        return res.status(400).json({
          message: `No se puede entregar más de lo pendiente para el detalle ${detalleId}. Pendiente: ${remainingToDeliver}`,
        })
      }

      const newCantidadEntregada = detail.cantidad_entregada + quantity

      // Actualizar cantidad_entregada en detalles_ventas
      await connection.query("UPDATE detalles_ventas SET cantidad_entregada = ? WHERE id = ?", [
        newCantidadEntregada,
        detalleId,
      ])

      // Decrementar stock del producto y registrar movimiento de salida
      const [productStock] = await connection.query("SELECT stock FROM productos WHERE id = ? FOR UPDATE", [
        detail.producto_id,
      ])
      const currentStock = productStock[0].stock
      const newStock = currentStock - quantity

      await connection.query("UPDATE productos SET stock = ? WHERE id = ?", [newStock, detail.producto_id])

      await connection.query(
        `
        INSERT INTO movimientos_stock (
          producto_id, usuario_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo
        ) VALUES (?, ?, 'salida', ?, ?, ?, ?)
      `,
        [
          detail.producto_id,
          req.user.id,
          quantity,
          currentStock,
          newStock,
          `Entrega de venta ${sale.numero_factura} - Detalle ${detalleId}`,
        ],
      )

      if (newCantidadEntregada < detail.cantidad) {
        allProductsDelivered = false
      }
    }

    // Verificar si todos los productos de la venta han sido entregados
    const [allDetails] = await connection.query(
      "SELECT cantidad, cantidad_entregada FROM detalles_ventas WHERE venta_id = ?",
      [id],
    )

    const finalAllProductsDelivered = allDetails.every((d) => d.cantidad_entregada >= d.cantidad)

    if (finalAllProductsDelivered && sale.estado !== "completada") {
      // Solo actualizar a 'completada' si no lo está ya
      await connection.query("UPDATE ventas SET estado = 'completada' WHERE id = ?", [id])
    } else if (!finalAllProductsDelivered && sale.estado !== "pendiente") {
      // Si no todos fueron entregados, asegurar que esté 'pendiente'
      await connection.query("UPDATE ventas SET estado = 'pendiente' WHERE id = ?", [id])
    }

    await connection.commit()

    res.status(200).json({
      message: finalAllProductsDelivered
        ? "Venta completada y productos entregados exitosamente"
        : "Productos entregados parcialmente. Venta sigue pendiente.",
      data: {
        saleId: id,
        numeroFactura: sale.numero_factura,
        newStatus: finalAllProductsDelivered ? "completada" : "pendiente",
        allProductsDelivered: finalAllProductsDelivered,
      },
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al entregar productos:", error)
    res.status(500).json({ message: error.message || "Error al entregar productos" })
  } finally {
    connection.release()
  }
}
