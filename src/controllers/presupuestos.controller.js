// presupuestos.controller.js - ACTUALIZADO PARA FUNCIONAR COMO VENTA SIN FACTURA
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

// Función para generar el próximo número de presupuesto
const generatePresupuestoNumber = async (connection) => {
  try {
    const [config] = await connection.query(`
      SELECT clave, valor FROM configuracion 
      WHERE clave IN ('presupuesto_numero_siguiente', 'presupuesto_prefijo')
      FOR UPDATE
    `)

    if (config.length === 0) {
      throw new Error("No se encontró configuración de numeración de presupuestos")
    }

    const configObj = {}
    config.forEach((item) => {
      configObj[item.clave] = item.valor
    })

    if (!configObj.presupuesto_numero_siguiente) {
      throw new Error("No se encontró el próximo número de presupuesto en la configuración")
    }

    const nextNumber = Number.parseInt(configObj.presupuesto_numero_siguiente)
    if (isNaN(nextNumber) || nextNumber < 1) {
      throw new Error(`Número de presupuesto inválido en configuración: ${configObj.presupuesto_numero_siguiente}`)
    }

    const prefix = configObj.presupuesto_prefijo || "PRES-"
    const presupuestoNumber = `${prefix}${nextNumber.toString().padStart(6, "0")}`

    const [updateResult] = await connection.query(
      "UPDATE configuracion SET valor = ? WHERE clave = 'presupuesto_numero_siguiente'",
      [(nextNumber + 1).toString()],
    )

    if (updateResult.affectedRows === 0) {
      throw new Error("No se pudo actualizar el contador de presupuestos")
    }

    return presupuestoNumber
  } catch (error) {
    console.error("Error al generar número de presupuesto:", error)
    throw new Error(`Error al generar número de presupuesto: ${error.message}`)
  }
}

// Crear un nuevo presupuesto (FUNCIONA IGUAL QUE UNA VENTA)
export const createPresupuesto = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const {
      clienteId,
      productos,
      descuento = 0,
      interes = 0,
      observaciones = "",
      pagos = [],
      fechaPresupuesto,
    } = req.body

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
    const productsToProcess = []
    let shouldBePending = false

    // Generar número de presupuesto
    const numeroPresupuesto = await generatePresupuestoNumber(connection)

    if (!numeroPresupuesto) {
      await connection.rollback()
      return res.status(500).json({ message: "Error al generar número de presupuesto" })
    }

    // PROCESAR PRODUCTOS IGUAL QUE EN VENTAS (AFECTAR STOCK)
    for (const item of productos) {
      const [producto] = await connection.query(
        "SELECT id, nombre, stock, precio_venta FROM productos WHERE id = ? AND activo = TRUE FOR UPDATE",
        [item.productoId],
      )

      if (producto.length === 0) {
        await connection.rollback()
        return res.status(404).json({ message: `Producto con ID ${item.productoId} no encontrado` })
      }

      const prod = producto[0]
      const cantidad_solicitada = Number.parseInt(item.cantidad)
      const stock_disponible = Number.parseInt(prod.stock)

      // Determinar cuánto se puede entregar inmediatamente
      const cantidad_entregada_inicial = Math.min(cantidad_solicitada, stock_disponible)
      const cantidad_pendiente_inicial = cantidad_solicitada - cantidad_entregada_inicial

      if (cantidad_pendiente_inicial > 0) {
        shouldBePending = true
      }

      const precioUnitario = Number.parseFloat(item.precioUnitario || prod.precio_venta)
      const subtotalItem = precioUnitario * cantidad_solicitada
      const discountPercentage = Number.parseFloat(item.discount_percentage || 0)

      // ACTUALIZAR STOCK (IGUAL QUE EN VENTAS)
      const newStock = stock_disponible - cantidad_solicitada
      await connection.query("UPDATE productos SET stock = ? WHERE id = ?", [newStock, item.productoId])

      // REGISTRAR MOVIMIENTO DE STOCK
      if (cantidad_entregada_inicial > 0) {
        await connection.query(
          `
          INSERT INTO movimientos_stock (
            producto_id, usuario_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo
          ) VALUES (?, ?, 'salida', ?, ?, ?, ?)
        `,
          [
            item.productoId,
            req.user.id,
            cantidad_entregada_inicial,
            stock_disponible,
            newStock,
            `Presupuesto ${numeroPresupuesto} - Entrega inicial (${cantidad_entregada_inicial} de ${cantidad_solicitada} solicitadas)`,
          ],
        )
      }

      productsToProcess.push({
        ...item,
        nombre: prod.nombre,
        precioUnitario,
        cantidad: cantidad_solicitada,
        subtotalItem,
        discount_percentage: discountPercentage,
        cantidad_entregada_inicial: cantidad_entregada_inicial,
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
        message: `El total de pagos ($${totalPagos.toFixed(2)}) no coincide con el total del presupuesto ($${total.toFixed(2)})`,
      })
    }

    const pagoCuentaCorriente = pagos.find((pago) => pago.tipo === "cuenta_corriente")
    const tieneCuentaCorriente = !!pagoCuentaCorriente

    // MANEJAR CUENTA CORRIENTE IGUAL QUE EN VENTAS
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

    // Determinar el estado inicial
    const initialStatus = shouldBePending ? "pendiente" : "completada"

    const [presupuestoResult] = await connection.query(
      `
      INSERT INTO presupuestos (
        numero_presupuesto, cliente_id, usuario_id, fecha_presupuesto,
        subtotal, descuento, interes, total, observaciones,
        tiene_cuenta_corriente, empresa_datos, estado
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        numeroPresupuesto,
        clienteId,
        req.user.id,
        fechaPresupuesto,
        subtotal,
        descuentoNum,
        interesNum,
        total,
        observaciones,
        tieneCuentaCorriente,
        JSON.stringify(empresaDatos),
        initialStatus,
      ],
    )

    const presupuestoId = presupuestoResult.insertId

    // INSERTAR DETALLES CON CANTIDAD ENTREGADA
    for (const item of productsToProcess) {
      const discountPercentage = Number.parseFloat(item.discount_percentage || 0)

      await connection.query(
        "INSERT INTO detalles_presupuestos (presupuesto_id, producto_id, cantidad, precio_unitario, subtotal, discount_percentage, cantidad_entregada) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          presupuestoId,
          item.productoId,
          item.cantidad,
          item.precioUnitario,
          item.subtotalItem,
          discountPercentage,
          item.cantidad_entregada_inicial,
        ],
      )
    }

    let movimientoCuentaId = null

    // PROCESAR PAGOS IGUAL QUE EN VENTAS
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
          ) VALUES (?, ?, 'debito', 'presupuesto', ?, ?, ?, ?, 'presupuesto', ?, ?)
        `,
          [
            clienteId,
            req.user.id,
            montoCuentaCorriente,
            saldoAnterior,
            nuevoSaldo,
            presupuestoId,
            numeroPresupuesto,
            `Presupuesto ${numeroPresupuesto} - ${cliente.nombre}`,
          ],
        )

        movimientoId = movimientoResult.insertId
        movimientoCuentaId = movimientoId

        await connection.query("UPDATE clientes SET saldo_cuenta_corriente = ROUND(?, 2) WHERE id = ?", [
          nuevoSaldo,
          clienteId,
        ])

        await connection.query("UPDATE presupuestos SET movimiento_cuenta_id = ? WHERE id = ?", [
          movimientoId,
          presupuestoId,
        ])
      }

      await connection.query(
        "INSERT INTO presupuesto_pagos (presupuesto_id, tipo_pago, monto, descripcion, movimiento_cuenta_id) VALUES (?, ?, ?, ?, ?)",
        [presupuestoId, pago.tipo, Number.parseFloat(pago.monto), pago.descripcion || "", movimientoId],
      )
    }

    await connection.commit()

    res.status(201).json({
      message: `Presupuesto creado exitosamente como ${initialStatus}`,
      data: {
        id: presupuestoId,
        numeroPresupuesto: numeroPresupuesto,
        total,
        tieneCuentaCorriente,
        movimientoCuentaId,
        empresaDatos,
        estado: initialStatus,
      },
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al crear presupuesto:", error)
    res.status(500).json({
      message: error.message || "Error al crear presupuesto",
      details: error.stack,
    })
  } finally {
    connection.release()
  }
}

// Obtener un presupuesto por ID
export const getPresupuestoById = async (req, res) => {
  try {
    const { id } = req.params

    const [presupuestos] = await pool.query(
      `
      SELECT 
        p.*,
        c.nombre as cliente_nombre,
        c.telefono as cliente_telefono,
        c.email as cliente_email,
        c.direccion as cliente_direccion,
        c.cuit as cliente_cuit,
        u.nombre as usuario_nombre
      FROM presupuestos p
      JOIN clientes c ON p.cliente_id = c.id
      JOIN usuarios u ON p.usuario_id = u.id
      WHERE p.id = ?
    `,
      [id],
    )

    if (presupuestos.length === 0) {
      return res.status(404).json({ message: "Presupuesto no encontrado" })
    }

    const presupuesto = presupuestos[0]

    let empresaDatos = null
    if (presupuesto.empresa_datos) {
      try {
        empresaDatos = JSON.parse(presupuesto.empresa_datos)
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
        dp.*,
        p.nombre as producto_nombre,
        p.codigo as producto_codigo,
        p.marca as producto_marca,
        p.stock as producto_stock_actual
      FROM detalles_presupuestos dp
      JOIN productos p ON dp.producto_id = p.id
      WHERE dp.presupuesto_id = ?
      ORDER BY dp.id
    `,
      [id],
    )

    const [payments] = await pool.query(
      `
      SELECT 
        pp.*,
        mcc.numero_referencia as movimiento_numero,
        mcc.descripcion as movimiento_descripcion
      FROM presupuesto_pagos pp
      LEFT JOIN movimientos_cuenta_corriente mcc ON pp.movimiento_cuenta_id = mcc.id
      WHERE pp.presupuesto_id = ? 
      ORDER BY pp.id
    `,
      [id],
    )

    const presupuestoData = {
      ...presupuesto,
      fecha_presupuesto: presupuesto.fecha_presupuesto.toISOString().split("T")[0],
      fecha_creacion: presupuesto.fecha_creacion.toISOString(),
      fecha_actualizacion: presupuesto.fecha_actualizacion.toISOString(),
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

    res.status(200).json(presupuestoData)
  } catch (error) {
    console.error("Error al obtener presupuesto:", error)
    res.status(500).json({ message: "Error al obtener presupuesto" })
  }
}

// Obtener presupuestos con filtros y paginación
export const getPresupuestos = async (req, res) => {
  try {
    const {
      fechaInicio = "",
      fechaFin = "",
      cliente = "",
      numeroPresupuesto = "",
      estado = "todos",
      limit = 10,
      offset = 0,
    } = req.query

    let baseQuery = `
      FROM presupuestos p
      JOIN clientes c ON p.cliente_id = c.id
      JOIN usuarios u ON p.usuario_id = u.id
      WHERE 1=1
    `

    const queryParams = []

    if (fechaInicio) {
      baseQuery += ` AND DATE(p.fecha_presupuesto) >= ?`
      queryParams.push(fechaInicio)
    }

    if (fechaFin) {
      baseQuery += ` AND DATE(p.fecha_presupuesto) <= ?`
      queryParams.push(fechaFin)
    }

    if (cliente) {
      baseQuery += ` AND c.nombre LIKE ?`
      queryParams.push(`%${cliente}%`)
    }

    if (numeroPresupuesto) {
      baseQuery += ` AND p.numero_presupuesto LIKE ?`
      queryParams.push(`%${numeroPresupuesto}%`)
    }

    if (estado !== "todos") {
      baseQuery += ` AND p.estado = ?`
      queryParams.push(estado)
    }

    // Consulta de conteo
    const countQuery = `SELECT COUNT(*) as total ${baseQuery}`
    const [[{ total }]] = await pool.query(countQuery, queryParams)

    // Consulta de datos con paginación
    const dataQuery = `
      SELECT 
        p.id,
        p.numero_presupuesto,
        p.fecha_presupuesto,
        p.subtotal,
        p.descuento,
        p.interes,
        p.total,
        p.estado,
        p.observaciones,
        p.tiene_cuenta_corriente,
        p.fecha_creacion,
        c.nombre as cliente_nombre,
        u.nombre as usuario_nombre
      ${baseQuery}
      ORDER BY p.fecha_presupuesto DESC, p.id DESC
      LIMIT ? OFFSET ?
    `
    const finalDataParams = [...queryParams, Number.parseInt(limit), Number.parseInt(offset)]
    const [presupuestos] = await pool.query(dataQuery, finalDataParams)

    const presupuestosWithISODate = presupuestos.map((presupuesto) => ({
      ...presupuesto,
      fecha_presupuesto: presupuesto.fecha_presupuesto.toISOString().split("T")[0],
      fecha_creacion: presupuesto.fecha_creacion.toISOString(),
    }))

    res.status(200).json({
      success: true,
      data: presupuestosWithISODate,
      pagination: {
        totalItems: total,
        totalPages: Math.ceil(total / limit),
        currentPage: Math.floor(offset / limit) + 1,
        itemsPerPage: Number.parseInt(limit),
      },
    })
  } catch (error) {
    console.error("Error al obtener presupuestos:", error)
    res.status(500).json({
      success: false,
      message: "Error al obtener presupuestos",
      error: error.message,
    })
  }
}

// Anular presupuesto (IGUAL QUE ANULAR VENTA)
export const cancelPresupuesto = async (req, res) => {
  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const { id } = req.params
    const { motivo = "" } = req.body

    const [presupuestos] = await connection.query("SELECT * FROM presupuestos WHERE id = ? AND estado != 'anulado'", [
      id,
    ])

    if (presupuestos.length === 0) {
      await connection.rollback()
      return res.status(404).json({ message: "Presupuesto no encontrado o ya está anulado" })
    }

    const presupuesto = presupuestos[0]

    // Revertir stock
    const [details] = await connection.query("SELECT * FROM detalles_presupuestos WHERE presupuesto_id = ?", [id])

    for (const detail of details) {
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
            `Anulación presupuesto ${presupuesto.numero_presupuesto} - ${motivo} (reversión de ${cantidadARevertir} unidades entregadas)`,
          ],
        )
      }
    }

    // Revertir cuenta corriente si aplica
    if (presupuesto.tiene_cuenta_corriente) {
      const [pagosCuentaCorriente] = await connection.query(
        `
        SELECT pp.*, mcc.* 
        FROM presupuesto_pagos pp
        JOIN movimientos_cuenta_corriente mcc ON pp.movimiento_cuenta_id = mcc.id
        WHERE pp.presupuesto_id = ? AND pp.tipo_pago = 'cuenta_corriente'
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
            ) VALUES (?, ?, 'credito', 'nota_credito', ?, ?, ?, ?, 'anulacion_presupuesto', ?, ?)
          `,
            [
              presupuesto.cliente_id,
              req.user.id,
              montoRevertir,
              saldoAnterior,
              nuevoSaldo,
              id,
              presupuesto.numero_presupuesto,
              `Anulación presupuesto ${presupuesto.numero_presupuesto} - ${motivo}`,
            ],
          )

          await connection.query("UPDATE clientes SET saldo_cuenta_corriente = ROUND(?, 2) WHERE id = ?", [
            nuevoSaldo,
            presupuesto.cliente_id,
          ])
        }
      }
    }

    await connection.query(
      "UPDATE presupuestos SET estado = 'anulado', observaciones = CONCAT(COALESCE(observaciones, ''), ' - ANULADO: ', ?) WHERE id = ?",
      [motivo, id],
    )

    await connection.commit()

    res.status(200).json({
      message: "Presupuesto anulado exitosamente",
      data: {
        id,
        numeroPresupuesto: presupuesto.numero_presupuesto,
        motivo,
      },
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al anular presupuesto:", error)
    res.status(500).json({ message: error.message || "Error al anular presupuesto" })
  } finally {
    connection.release()
  }
}

// NUEVA FUNCIÓN: Entregar productos de un presupuesto pendiente
export const deliverProductsPresupuesto = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const { id } = req.params
    const { deliveries } = req.body

    const [presupuestoResult] = await connection.query(
      "SELECT id, numero_presupuesto, estado FROM presupuestos WHERE id = ? FOR UPDATE",
      [id],
    )

    if (presupuestoResult.length === 0) {
      await connection.rollback()
      return res.status(404).json({ message: "Presupuesto no encontrado" })
    }

    const presupuesto = presupuestoResult[0]

    for (const delivery of deliveries) {
      const { detalleId, quantity } = delivery

      if (quantity <= 0) {
        continue
      }

      const [detailResult] = await connection.query(
        "SELECT id, producto_id, cantidad, cantidad_entregada FROM detalles_presupuestos WHERE id = ? AND presupuesto_id = ? FOR UPDATE",
        [detalleId, id],
      )

      if (detailResult.length === 0) {
        await connection.rollback()
        return res.status(404).json({ message: `Detalle de presupuesto con ID ${detalleId} no encontrado` })
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

      await connection.query("UPDATE detalles_presupuestos SET cantidad_entregada = ? WHERE id = ?", [
        newCantidadEntregada,
        detalleId,
      ])

      const [productStock] = await connection.query("SELECT stock FROM productos WHERE id = ? FOR UPDATE", [
        detail.producto_id,
      ])
      const currentStock = productStock[0].stock
      const newStock = currentStock + quantity

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
          `Entrega de presupuesto ${presupuesto.numero_presupuesto} - Cumpliendo pendiente (${quantity} unidades)`,
        ],
      )
    }

    // Verificar si todos los productos han sido entregados
    const [allDetails] = await connection.query(
      "SELECT cantidad, cantidad_entregada FROM detalles_presupuestos WHERE presupuesto_id = ?",
      [id],
    )

    const allProductsDelivered = allDetails.every((d) => d.cantidad_entregada >= d.cantidad)

    if (allProductsDelivered && presupuesto.estado !== "completado") {
      await connection.query("UPDATE presupuestos SET estado = 'completado' WHERE id = ?", [id])
    } else if (!allProductsDelivered && presupuesto.estado !== "pendiente") {
      await connection.query("UPDATE presupuestos SET estado = 'pendiente' WHERE id = ?", [id])
    }

    await connection.commit()

    res.status(200).json({
      message: allProductsDelivered
        ? "Presupuesto completado y productos entregados exitosamente"
        : "Productos entregados parcialmente. Presupuesto sigue pendiente.",
      data: {
        presupuestoId: id,
        numeroPresupuesto: presupuesto.numero_presupuesto,
        newStatus: allProductsDelivered ? "completado" : "pendiente",
        allProductsDelivered: allProductsDelivered,
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

// Obtener estadísticas de presupuestos
export const getPresupuestosStats = async (req, res) => {
  try {
    const { fechaInicio = "", fechaFin = "" } = req.query

    let whereClause = "WHERE 1=1"
    const queryParams = []

    if (fechaInicio) {
      whereClause += " AND DATE(p.fecha_presupuesto) >= ?"
      queryParams.push(fechaInicio)
    }

    if (fechaFin) {
      whereClause += " AND DATE(p.fecha_presupuesto) <= ?"
      queryParams.push(fechaFin)
    }

    const [generalStats] = await pool.query(
      `
      SELECT 
        COUNT(*) as total_presupuestos,
        SUM(CASE WHEN p.estado = 'completado' THEN p.total ELSE 0 END) as total_facturado,
        AVG(CASE WHEN p.estado = 'completado' THEN p.total ELSE NULL END) as promedio_presupuesto,
        SUM(CASE WHEN p.tiene_cuenta_corriente AND p.estado = 'completado' THEN 1 ELSE 0 END) as presupuestos_cuenta_corriente,
        SUM(CASE WHEN p.tiene_cuenta_corriente AND p.estado = 'completado' THEN p.total ELSE 0 END) as total_cuenta_corriente,
        SUM(CASE WHEN p.estado = 'completado' THEN 1 ELSE 0 END) as presupuestos_completados,
        SUM(CASE WHEN p.estado = 'anulado' THEN 1 ELSE 0 END) as presupuestos_anulados,
        SUM(CASE WHEN p.estado = 'pendiente' THEN 1 ELSE 0 END) as presupuestos_pendientes
      FROM presupuestos p
      ${whereClause}
    `,
      queryParams,
    )

    const stats = {
      estadisticas_generales: generalStats[0],
    }

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

// Actualizar presupuesto
export const updatePresupuesto = async (req, res) => {
  try {
    const { id } = req.params
    const { observaciones } = req.body

    const [result] = await pool.query("UPDATE presupuestos SET observaciones = ? WHERE id = ?", [observaciones, id])

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Presupuesto no encontrado" })
    }

    res.status(200).json({
      message: "Presupuesto actualizado exitosamente",
      data: { id, observaciones },
    })
  } catch (error) {
    console.error("Error al actualizar presupuesto:", error)
    res.status(500).json({ message: "Error al actualizar presupuesto" })
  }
}

// Cambiar estado de presupuesto (MANTENIDO PARA COMPATIBILIDAD)
export const updatePresupuestoEstado = async (req, res) => {
  try {
    const { id } = req.params
    const { estado, observaciones = "" } = req.body

    const validStates = ["activo", "completado", "pendiente", "anulado"]
    if (!validStates.includes(estado)) {
      return res.status(400).json({ message: "Estado inválido" })
    }

    const [result] = await pool.query(
      "UPDATE presupuestos SET estado = ?, observaciones = CONCAT(COALESCE(observaciones, ''), ' - ', ?) WHERE id = ?",
      [estado, observaciones, id],
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Presupuesto no encontrado" })
    }

    res.status(200).json({
      message: "Estado del presupuesto actualizado exitosamente",
      data: { id, estado, observaciones },
    })
  } catch (error) {
    console.error("Error al actualizar estado del presupuesto:", error)
    res.status(500).json({ message: "Error al actualizar estado del presupuesto" })
  }
}
