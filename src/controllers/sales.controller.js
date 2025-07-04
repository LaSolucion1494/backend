// sales.controller.js - VERSIÓN CON VALORES HARDCODEADOS PARA CUENTA CORRIENTE
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
    // Retornar datos por defecto en caso de error
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

// Función para generar el próximo número de factura (SIN CAMBIOS)
const generateInvoiceNumber = async (connection) => {
  try {
    // Obtener configuración con FOR UPDATE para evitar condiciones de carrera
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

    // Validar que tenemos los valores necesarios
    if (!configObj.venta_numero_siguiente) {
      throw new Error("No se encontró el próximo número de factura en la configuración")
    }

    const nextNumber = Number.parseInt(configObj.venta_numero_siguiente)
    if (isNaN(nextNumber) || nextNumber < 1) {
      throw new Error(`Número de factura inválido en configuración: ${configObj.venta_numero_siguiente}`)
    }

    const prefix = configObj.venta_prefijo || "FAC-"
    const invoiceNumber = `${prefix}${nextNumber.toString().padStart(6, "0")}`

    // Actualizar el siguiente número
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

// Crear una nueva venta (CON VALORES HARDCODEADOS PARA CUENTA CORRIENTE)
export const createSale = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const { clienteId, productos, descuento = 0, interes = 0, observaciones = "", pagos = [], fechaVenta } = req.body

    // Validar que hay productos
    if (!productos || productos.length === 0) {
      await connection.rollback()
      return res.status(400).json({ message: "Debe incluir al menos un producto" })
    }

    // Validar que hay al menos un método de pago
    if (!pagos || pagos.length === 0) {
      await connection.rollback()
      return res.status(400).json({ message: "Debe incluir al menos un método de pago" })
    }

    // Obtener datos de la empresa al momento de la venta
    const empresaDatos = await getCompanyDataFromConfig(connection)

    // Verificar que el cliente existe y obtener info de cuenta corriente
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

    // Verificar stock y calcular subtotal
    let subtotal = 0
    const productosValidados = []

    for (const item of productos) {
      const [producto] = await connection.query(
        "SELECT id, nombre, stock, precio_venta FROM productos WHERE id = ? AND activo = TRUE",
        [item.productoId],
      )

      if (producto.length === 0) {
        await connection.rollback()
        return res.status(404).json({ message: `Producto con ID ${item.productoId} no encontrado` })
      }

      const prod = producto[0]

      if (prod.stock < item.cantidad) {
        await connection.rollback()
        return res.status(400).json({
          message: `Stock insuficiente para ${prod.nombre}. Stock disponible: ${prod.stock}`,
        })
      }

      const precioUnitario = Number.parseFloat(item.precioUnitario || prod.precio_venta)
      const cantidad = Number.parseInt(item.cantidad)
      const subtotalItem = precioUnitario * cantidad
      const discountPercentage = Number.parseFloat(item.discount_percentage || 0)

      productosValidados.push({
        ...item,
        nombre: prod.nombre,
        precioUnitario,
        cantidad,
        subtotalItem,
        discount_percentage: discountPercentage,
      })

      subtotal += subtotalItem
    }

    const descuentoNum = Number.parseFloat(descuento)
    const interesNum = Number.parseFloat(interes)
    const total = subtotal - descuentoNum + interesNum

    // Validar que el total de pagos coincida con el total de la venta
    const totalPagos = pagos.reduce((sum, pago) => sum + Number.parseFloat(pago.monto), 0)
    if (Math.abs(totalPagos - total) > 0.01) {
      await connection.rollback()
      return res.status(400).json({
        message: `El total de pagos ($${totalPagos.toFixed(2)}) no coincide con el total de la venta ($${total.toFixed(2)})`,
      })
    }

    // Verificar si hay pago con cuenta corriente
    const pagoCuentaCorriente = pagos.find((pago) => pago.tipo === "cuenta_corriente")
    const tieneCuentaCorriente = !!pagoCuentaCorriente

    if (tieneCuentaCorriente) {
      // Verificar que la funcionalidad de cuenta corriente esté activa (HARDCODEADO)
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

    // Generar número de factura
    const numeroFactura = await generateInvoiceNumber(connection)

    if (!numeroFactura) {
      await connection.rollback()
      return res.status(500).json({ message: "Error al generar número de factura" })
    }

    // Crear la venta con datos de empresa
    const [ventaResult] = await connection.query(
      `
      INSERT INTO ventas (
        numero_factura, cliente_id, usuario_id, fecha_venta,
        subtotal, descuento, interes, total, observaciones,
        tiene_cuenta_corriente, empresa_datos
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        JSON.stringify(empresaDatos), // Guardar datos de empresa como JSON
      ],
    )

    const ventaId = ventaResult.insertId

    // Insertar detalles de la venta y actualizar stock
    for (const item of productosValidados) {
      // Asegurarse de que discount_percentage sea un número
      const discountPercentage = Number.parseFloat(item.discount_percentage || 0)

      await connection.query(
        "INSERT INTO detalles_ventas (venta_id, producto_id, cantidad, precio_unitario, subtotal, discount_percentage) VALUES (?, ?, ?, ?, ?, ?)",
        [ventaId, item.productoId, item.cantidad, item.precioUnitario, item.subtotalItem, discountPercentage],
      )

      const [stockActual] = await connection.query("SELECT stock FROM productos WHERE id = ?", [item.productoId])
      const nuevoStock = stockActual[0].stock - item.cantidad

      await connection.query("UPDATE productos SET stock = ? WHERE id = ?", [nuevoStock, item.productoId])

      await connection.query(
        `
        INSERT INTO movimientos_stock (
          producto_id, usuario_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo
        ) VALUES (?, ?, 'salida', ?, ?, ?, ?)
      `,
        [item.productoId, req.user.id, item.cantidad, stockActual[0].stock, nuevoStock, `Venta ${numeroFactura}`],
      )
    }

    // Procesar pagos
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
      message: "Venta creada exitosamente",
      data: {
        id: ventaId,
        numeroFactura: numeroFactura,
        total,
        tieneCuentaCorriente,
        movimientoCuentaId,
        empresaDatos, // Incluir datos de empresa en la respuesta
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

// Obtener una venta por ID incluyendo datos de empresa (SIN CAMBIOS)
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

    // Parsear datos de empresa desde JSON
    let empresaDatos = null
    if (sale.empresa_datos) {
      try {
        empresaDatos = JSON.parse(sale.empresa_datos)
      } catch (error) {
        console.error("Error al parsear datos de empresa:", error)
        // Si hay error, obtener datos actuales de configuración como fallback
        const connection = await pool.getConnection()
        try {
          empresaDatos = await getCompanyDataFromConfig(connection)
        } finally {
          connection.release()
        }
      }
    } else {
      // Si no hay datos guardados, obtener datos actuales de configuración
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
        p.codigo as producto_codigo
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
      empresa_datos: empresaDatos, // Incluir datos de empresa
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

// Anular venta (SIN CAMBIOS SIGNIFICATIVOS)
export const cancelSale = async (req, res) => {
  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const { id } = req.params
    const { motivo = "" } = req.body

    const [sales] = await connection.query("SELECT * FROM ventas WHERE id = ? AND estado = 'completada'", [id])

    if (sales.length === 0) {
      await connection.rollback()
      return res.status(404).json({ message: "Venta no encontrada o ya está anulada" })
    }

    const sale = sales[0]

    const [details] = await connection.query("SELECT * FROM detalles_ventas WHERE venta_id = ?", [id])

    for (const detail of details) {
      const [stockActual] = await connection.query("SELECT stock FROM productos WHERE id = ?", [detail.producto_id])

      const nuevoStock = stockActual[0].stock + detail.cantidad

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
          detail.cantidad,
          stockActual[0].stock,
          nuevoStock,
          `Anulación venta ${sale.numero_factura} - ${motivo}`,
        ],
      )
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

// Obtener ventas (SIN CAMBIOS)
export const getSales = async (req, res) => {
  try {
    const { fechaInicio = "", fechaFin = "", cliente = "", estado = "todos", limit = 50, offset = 0 } = req.query

    let query = `
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
      FROM ventas v
      JOIN clientes c ON v.cliente_id = c.id
      JOIN usuarios u ON v.usuario_id = u.id
      WHERE 1=1
    `

    const queryParams = []

    if (fechaInicio) {
      query += ` AND DATE(v.fecha_venta) >= ?`
      queryParams.push(fechaInicio)
    }

    if (fechaFin) {
      query += ` AND DATE(v.fecha_venta) <= ?`
      queryParams.push(fechaFin)
    }

    if (cliente) {
      query += ` AND c.nombre LIKE ?`
      queryParams.push(`%${cliente}%`)
    }

    if (estado !== "todos") {
      query += ` AND v.estado = ?`
      queryParams.push(estado)
    }

    query += ` ORDER BY v.fecha_venta DESC, v.id DESC LIMIT ? OFFSET ?`
    queryParams.push(Number.parseInt(limit), Number.parseInt(offset))

    const [sales] = await pool.query(query, queryParams)

    const salesWithISODate = sales.map((sale) => ({
      ...sale,
      fecha_venta: sale.fecha_venta.toISOString().split("T")[0],
      fecha_creacion: sale.fecha_creacion.toISOString(),
    }))

    res.status(200).json(salesWithISODate)
  } catch (error) {
    console.error("Error al obtener ventas:", error)
    res.status(500).json({ message: "Error al obtener ventas" })
  }
}

// Obtener ventas por cliente (SIN CAMBIOS)
export const getSalesByClient = async (req, res) => {
  try {
    const { clientId } = req.params
    const { limit = 50, offset = 0, estado = "todos" } = req.query

    const [client] = await pool.query("SELECT id, nombre FROM clientes WHERE id = ? AND activo = TRUE", [clientId])

    if (client.length === 0) {
      return res.status(404).json({ message: "Cliente no encontrado" })
    }

    let query = `
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
      FROM ventas v
      JOIN usuarios u ON v.usuario_id = u.id
      WHERE v.cliente_id = ?
    `

    const queryParams = [clientId]

    if (estado !== "todos") {
      query += ` AND v.estado = ?`
      queryParams.push(estado)
    }

    query += ` ORDER BY v.fecha_venta DESC, v.id DESC LIMIT ? OFFSET ?`
    queryParams.push(Number.parseInt(limit), Number.parseInt(offset))

    const [sales] = await pool.query(query, queryParams)

    const salesWithISODate = sales.map((sale) => ({
      ...sale,
      fecha_venta: sale.fecha_venta.toISOString().split("T")[0],
      fecha_creacion: sale.fecha_creacion.toISOString(),
    }))

    const [totalCount] = await pool.query(
      `SELECT COUNT(*) as total FROM ventas WHERE cliente_id = ? ${estado !== "todos" ? "AND estado = ?" : ""}`,
      estado !== "todos" ? [clientId, estado] : [clientId],
    )

    res.status(200).json({
      cliente: client[0],
      ventas: salesWithISODate,
      total: totalCount[0].total,
    })
  } catch (error) {
    console.error("Error al obtener ventas del cliente:", error)
    res.status(500).json({ message: "Error al obtener ventas del cliente" })
  }
}

// Obtener estadísticas de ventas (SIN CAMBIOS)
export const getSalesStats = async (req, res) => {
  try {
    const { fechaInicio = "", fechaFin = "" } = req.query

    let whereClause = "WHERE v.estado = 'completada'"
    const queryParams = []

    if (fechaInicio) {
      whereClause += " AND DATE(v.fecha_venta) >= ?"
      queryParams.push(fechaInicio)
    }

    if (fechaFin) {
      whereClause += " AND DATE(v.fecha_venta) <= ?"
      queryParams.push(fechaFin)
    }

    // Estadísticas generales
    const [generalStats] = await pool.query(
      `
      SELECT 
        COUNT(*) as total_ventas,
        SUM(v.total) as total_facturado,
        AVG(v.total) as promedio_venta,
        SUM(CASE WHEN v.tiene_cuenta_corriente THEN 1 ELSE 0 END) as ventas_cuenta_corriente,
        SUM(CASE WHEN v.tiene_cuenta_corriente THEN v.total ELSE 0 END) as total_cuenta_corriente
      FROM ventas v
      ${whereClause}
    `,
      queryParams,
    )

    // Ventas por día
    const [salesByDay] = await pool.query(
      `
      SELECT 
        DATE(v.fecha_venta) as fecha,
        COUNT(*) as cantidad_ventas,
        SUM(v.total) as total_dia
      FROM ventas v
      ${whereClause}
      GROUP BY DATE(v.fecha_venta)
      ORDER BY fecha DESC
      LIMIT 30
    `,
      queryParams,
    )

    // Top clientes
    const [topClients] = await pool.query(
      `
      SELECT 
        c.id,
        c.nombre,
        COUNT(v.id) as cantidad_compras,
        SUM(v.total) as total_comprado
      FROM ventas v
      JOIN clientes c ON v.cliente_id = c.id
      ${whereClause}
      GROUP BY c.id
      ORDER BY total_comprado DESC
      LIMIT 10
    `,
      queryParams,
    )

    // Métodos de pago
    const [paymentMethods] = await pool.query(
      `
      SELECT 
        vp.tipo_pago,
        COUNT(vp.id) as cantidad_usos,
        SUM(vp.monto) as total_monto
      FROM venta_pagos vp
      JOIN ventas v ON vp.venta_id = v.id
      ${whereClause.replace("WHERE", "WHERE")}
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

    res.status(200).json(stats)
  } catch (error) {
    console.error("Error al obtener estadísticas:", error)
    res.status(500).json({ message: "Error al obtener estadísticas" })
  }
}

// Obtener resumen del día (SIN CAMBIOS)
export const getTodaySummary = async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0]

    // Resumen general del día
    const [summary] = await pool.query(
      `
      SELECT 
        COUNT(*) as total_ventas,
        SUM(v.total) as total_facturado,
        SUM(CASE WHEN v.tiene_cuenta_corriente THEN 1 ELSE 0 END) as ventas_cuenta_corriente,
        SUM(CASE WHEN v.tiene_cuenta_corriente THEN v.total ELSE 0 END) as total_cuenta_corriente
      FROM ventas v
      WHERE DATE(v.fecha_venta) = ? AND v.estado = 'completada'
    `,
      [today],
    )

    // Métodos de pago del día
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

    // Productos más vendidos del día
    const [topProducts] = await pool.query(
      `
      SELECT 
        p.id,
        p.nombre,
        p.codigo,
        SUM(dv.cantidad) as cantidad_vendida,
        SUM(dv.subtotal) as total_vendido
      FROM detalles_ventas dv
      JOIN ventas v ON dv.venta_id = v.id
      JOIN productos p ON dv.producto_id = p.id
      WHERE DATE(v.fecha_venta) = ? AND v.estado = 'completada'
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

// Actualizar venta (SIN CAMBIOS)
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
