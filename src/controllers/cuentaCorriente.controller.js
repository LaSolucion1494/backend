// cuentaCorriente.controller.js - CONTROLADOR CON VALORES HARDCODEADOS
import pool from "../db.js"
import { validationResult } from "express-validator"

// VALORES HARDCODEADOS PARA CUENTA CORRIENTE
const CUENTA_CORRIENTE_CONFIG = {
  activa: true,
  limite_credito_default: 50000,
  pago_prefijo: "REC-",
}

// Función para generar el próximo número de recibo (CON VALORES HARDCODEADOS)
const generateReceiptNumber = async (connection) => {
  try {
    // Obtener solo el número siguiente, el prefijo está hardcodeado
    const [config] = await connection.query(`
      SELECT valor FROM configuracion 
      WHERE clave = 'pago_numero_siguiente'
    `)

    let nextNumber = 1
    if (config.length > 0) {
      nextNumber = Number.parseInt(config[0].valor || 1)
    } else {
      // Si no existe la configuración, crearla
      await connection.query(
        "INSERT INTO configuracion (clave, valor, descripcion, tipo) VALUES ('pago_numero_siguiente', '1', 'Próximo número de recibo de pago a generar', 'numero') ON DUPLICATE KEY UPDATE valor = valor",
      )
    }

    const prefix = CUENTA_CORRIENTE_CONFIG.pago_prefijo
    const receiptNumber = `${prefix}${nextNumber.toString().padStart(6, "0")}`

    // Actualizar el siguiente número
    await connection.query("UPDATE configuracion SET valor = ? WHERE clave = 'pago_numero_siguiente'", [
      (nextNumber + 1).toString(),
    ])

    return receiptNumber
  } catch (error) {
    console.error("Error al generar número de recibo:", error)
    throw error
  }
}

// Registrar un pago de cuenta corriente
export const registrarPago = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const { cliente_id, monto, fecha_pago, comprobante = "", notas = "" } = req.body

    // Validar que el monto sea positivo
    if (monto <= 0) {
      await connection.rollback()
      return res.status(400).json({ message: "El monto debe ser mayor a 0" })
    }

    // Validar que el cliente existe y tiene cuenta corriente
    const [clientData] = await connection.query(
      `SELECT 
        c.id, 
        c.nombre, 
        c.tiene_cuenta_corriente,
        c.saldo_cuenta_corriente,
        c.limite_credito
      FROM clientes c
      WHERE c.id = ? AND c.activo = TRUE AND c.tiene_cuenta_corriente = TRUE`,
      [cliente_id],
    )

    if (clientData.length === 0) {
      await connection.rollback()
      return res.status(404).json({ message: "Cliente no encontrado o no tiene cuenta corriente activa" })
    }

    const cliente = clientData[0]

    // Validar que el cliente tenga saldo pendiente
    if (cliente.saldo_cuenta_corriente <= 0.01) {
      await connection.rollback()
      return res.status(400).json({ message: "El cliente no tiene saldo pendiente para pagar" })
    }

    // Validar que el monto no sea mayor al saldo actual
    if (monto > cliente.saldo_cuenta_corriente + 0.01) {
      await connection.rollback()
      return res.status(400).json({
        message: `El monto del pago ($${monto.toFixed(2)}) no puede ser mayor al saldo actual ($${cliente.saldo_cuenta_corriente.toFixed(2)})`,
      })
    }

    // Generar número de recibo
    const numeroRecibo = await generateReceiptNumber(connection)

    // Obtener el saldo actual con FOR UPDATE
    const [saldoActualResult] = await connection.query(
      "SELECT saldo_cuenta_corriente FROM clientes WHERE id = ? FOR UPDATE",
      [cliente_id],
    )

    const saldoAnterior = saldoActualResult[0].saldo_cuenta_corriente
    const nuevoSaldo = Math.max(0, saldoAnterior - monto) // Disminuye la deuda

    // Actualizar saldo de la cuenta corriente
    await connection.query("UPDATE clientes SET saldo_cuenta_corriente = ROUND(?, 2) WHERE id = ?", [
      nuevoSaldo,
      cliente_id,
    ])

    // Crear movimiento de cuenta corriente
    const [movimientoResult] = await connection.query(
      `
      INSERT INTO movimientos_cuenta_corriente (
        cliente_id, usuario_id, tipo, concepto,
        monto, saldo_anterior, saldo_nuevo, referencia_tipo,
        numero_referencia, descripcion
      ) VALUES (?, ?, 'credito', 'pago', ?, ?, ?, 'pago', ?, ?)
    `,
      [
        cliente_id,
        req.user.id,
        monto,
        saldoAnterior,
        nuevoSaldo,
        numeroRecibo,
        `Pago ${numeroRecibo}${notas ? " - " + notas : ""}`,
      ],
    )

    const movimientoId = movimientoResult.insertId

    // Registrar el pago en la tabla de pagos
    const [pagoResult] = await connection.query(
      `
      INSERT INTO pagos_cuenta_corriente (
        cliente_id, usuario_id, numero_recibo,
        monto, tipo_pago, fecha_pago, observaciones, movimiento_cuenta_id, estado
      ) VALUES (?, ?, ?, ?, 'efectivo', ?, ?, ?, 'activo')
    `,
      [cliente_id, req.user.id, numeroRecibo, monto, fecha_pago, notas, movimientoId],
    )

    await connection.commit()

    res.status(201).json({
      message: "Pago registrado exitosamente",
      data: {
        id: pagoResult.insertId,
        numeroRecibo,
        saldoAnterior,
        nuevoSaldo,
        movimientoId,
        cliente: cliente.nombre,
      },
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al registrar pago:", error)
    res.status(500).json({ message: error.message || "Error al registrar pago" })
  } finally {
    connection.release()
  }
}

// Obtener historial de pagos de un cliente
export const getPagosByClient = async (req, res) => {
  try {
    const { clientId } = req.params
    const { limit = 50, offset = 0, estado = "activo" } = req.query

    // Verificar que el cliente existe
    const [client] = await pool.query(
      "SELECT id, nombre, tiene_cuenta_corriente, saldo_cuenta_corriente FROM clientes WHERE id = ? AND activo = TRUE",
      [clientId],
    )

    if (client.length === 0) {
      return res.status(404).json({ message: "Cliente no encontrado" })
    }

    if (!client[0].tiene_cuenta_corriente) {
      return res.status(400).json({ message: "El cliente no tiene cuenta corriente habilitada" })
    }

    let whereClause = "WHERE p.cliente_id = ?"
    const queryParams = [clientId]

    if (estado !== "todos") {
      whereClause += " AND p.estado = ?"
      queryParams.push(estado)
    }

    const [pagos] = await pool.query(
      `
      SELECT 
        p.id,
        p.numero_recibo,
        p.monto,
        p.tipo_pago,
        p.fecha_pago,
        p.observaciones,
        p.estado,
        p.fecha_creacion,
        u.nombre as usuario_nombre,
        mcc.saldo_anterior,
        mcc.saldo_nuevo
      FROM pagos_cuenta_corriente p
      JOIN usuarios u ON p.usuario_id = u.id
      LEFT JOIN movimientos_cuenta_corriente mcc ON p.movimiento_cuenta_id = mcc.id
      ${whereClause}
      ORDER BY p.fecha_pago DESC, p.id DESC
      LIMIT ? OFFSET ?
    `,
      [...queryParams, Number.parseInt(limit), Number.parseInt(offset)],
    )

    // Convertir fechas a ISO
    const pagosConFecha = pagos.map((pago) => ({
      ...pago,
      fecha_pago: pago.fecha_pago.toISOString().split("T")[0],
      fecha_creacion: pago.fecha_creacion.toISOString(),
    }))

    res.status(200).json({
      cliente: client[0],
      pagos: pagosConFecha,
    })
  } catch (error) {
    console.error("Error al obtener pagos:", error)
    res.status(500).json({ message: "Error al obtener pagos" })
  }
}

// Obtener todos los pagos con filtros
export const getPagos = async (req, res) => {
  try {
    const {
      cliente = "",
      fechaInicio = "",
      fechaFin = "",
      tipoPago = "",
      estado = "activo",
      limit = 50,
      offset = 0,
    } = req.query

    let query = `
      SELECT 
        p.id,
        p.numero_recibo,
        p.monto,
        p.tipo_pago,
        p.fecha_pago,
        p.observaciones,
        p.estado,
        p.fecha_creacion,
        c.nombre as cliente_nombre,
        u.nombre as usuario_nombre,
        mcc.saldo_anterior,
        mcc.saldo_nuevo
      FROM pagos_cuenta_corriente p
      JOIN clientes c ON p.cliente_id = c.id
      JOIN usuarios u ON p.usuario_id = u.id
      LEFT JOIN movimientos_cuenta_corriente mcc ON p.movimiento_cuenta_id = mcc.id
      WHERE 1=1
    `

    const queryParams = []

    // Filtros
    if (cliente) {
      query += ` AND c.nombre LIKE ?`
      queryParams.push(`%${cliente}%`)
    }

    if (fechaInicio) {
      query += ` AND DATE(p.fecha_pago) >= ?`
      queryParams.push(fechaInicio)
    }

    if (fechaFin) {
      query += ` AND DATE(p.fecha_pago) <= ?`
      queryParams.push(fechaFin)
    }

    if (tipoPago && tipoPago !== "todos") {
      query += ` AND p.tipo_pago = ?`
      queryParams.push(tipoPago)
    }

    if (estado !== "todos") {
      query += ` AND p.estado = ?`
      queryParams.push(estado)
    }

    query += ` ORDER BY p.fecha_pago DESC, p.id DESC LIMIT ? OFFSET ?`
    queryParams.push(Number.parseInt(limit), Number.parseInt(offset))

    const [pagos] = await pool.query(query, queryParams)

    // Convertir fechas a ISO
    const pagosConFecha = pagos.map((pago) => ({
      ...pago,
      fecha_pago: pago.fecha_pago.toISOString().split("T")[0],
      fecha_creacion: pago.fecha_creacion.toISOString(),
    }))

    res.status(200).json(pagosConFecha)
  } catch (error) {
    console.error("Error al obtener pagos:", error)
    res.status(500).json({ message: "Error al obtener pagos" })
  }
}

// Obtener un pago por ID
export const getPagoById = async (req, res) => {
  try {
    const { id } = req.params

    const [pagos] = await pool.query(
      `
      SELECT 
        p.id,
        p.cliente_id,
        p.numero_recibo,
        p.monto,
        p.tipo_pago,
        p.fecha_pago,
        p.observaciones,
        p.estado,
        p.fecha_creacion,
        c.nombre as cliente_nombre,
        c.telefono as cliente_telefono,
        c.email as cliente_email,
        c.direccion as cliente_direccion,
        c.cuit as cliente_cuit,
        u.nombre as usuario_nombre,
        mcc.saldo_anterior,
        mcc.saldo_nuevo,
        mcc.descripcion as movimiento_descripcion
      FROM pagos_cuenta_corriente p
      JOIN clientes c ON p.cliente_id = c.id
      JOIN usuarios u ON p.usuario_id = u.id
      LEFT JOIN movimientos_cuenta_corriente mcc ON p.movimiento_cuenta_id = mcc.id
      WHERE p.id = ?
    `,
      [id],
    )

    if (pagos.length === 0) {
      return res.status(404).json({ message: "Pago no encontrado" })
    }

    const pago = {
      ...pagos[0],
      fecha_pago: pagos[0].fecha_pago.toISOString().split("T")[0],
      fecha_creacion: pagos[0].fecha_creacion.toISOString(),
    }

    res.status(200).json(pago)
  } catch (error) {
    console.error("Error al obtener pago:", error)
    res.status(500).json({ message: "Error al obtener pago" })
  }
}

// Obtener resumen de cuenta corriente
export const getResumenCuentaCorriente = async (req, res) => {
  try {
    const { conSaldo = "todos" } = req.query

    let whereClause = "WHERE c.activo = TRUE AND c.tiene_cuenta_corriente = TRUE"
    const queryParams = []

    if (conSaldo === "true") {
      whereClause += " AND c.saldo_cuenta_corriente > 0.01"
    } else if (conSaldo === "false") {
      whereClause += " AND c.saldo_cuenta_corriente <= 0.01"
    }

    // Obtener cuentas corrientes
    const [cuentas] = await pool.query(
      `
      SELECT 
        c.id as cliente_id,
        c.nombre as cliente_nombre,
        c.telefono as cliente_telefono,
        c.email as cliente_email,
        c.limite_credito,
        c.saldo_cuenta_corriente as saldo_actual,
        CASE 
          WHEN c.limite_credito IS NULL THEN 999999999
          ELSE GREATEST(0, c.limite_credito - c.saldo_cuenta_corriente)
        END as saldo_disponible,
        c.fecha_actualizacion,
        (SELECT MAX(fecha_movimiento) FROM movimientos_cuenta_corriente WHERE cliente_id = c.id) as ultima_actividad,
        (SELECT concepto FROM movimientos_cuenta_corriente WHERE cliente_id = c.id ORDER BY fecha_movimiento DESC LIMIT 1) as ultimo_tipo
      FROM clientes c
      ${whereClause}
      ORDER BY c.saldo_cuenta_corriente DESC, c.nombre ASC
    `,
      queryParams,
    )

    // Obtener totales generales
    const [totales] = await pool.query(`
      SELECT 
        COUNT(*) as total_cuentas,
        SUM(CASE WHEN saldo_cuenta_corriente > 0.01 THEN 1 ELSE 0 END) as cuentas_con_saldo,
        SUM(saldo_cuenta_corriente) as saldo_total,
        AVG(saldo_cuenta_corriente) as saldo_promedio,
        SUM(CASE WHEN limite_credito IS NOT NULL THEN limite_credito ELSE 0 END) as limite_total
      FROM clientes
      WHERE tiene_cuenta_corriente = TRUE AND activo = TRUE
    `)

    // Obtener estadísticas de pagos del mes actual
    const [pagosMes] = await pool.query(`
      SELECT 
        COUNT(*) as total_pagos,
        COALESCE(SUM(monto), 0) as monto_total_pagos
      FROM pagos_cuenta_corriente
      WHERE MONTH(fecha_pago) = MONTH(CURRENT_DATE())
      AND YEAR(fecha_pago) = YEAR(CURRENT_DATE())
      AND estado = 'activo'
    `)

    // Obtener estadísticas de ventas a cuenta corriente del mes actual
    const [ventasMes] = await pool.query(`
      SELECT 
        COUNT(*) as total_ventas_cc,
        COALESCE(SUM(total), 0) as monto_total_ventas_cc
      FROM ventas
      WHERE tiene_cuenta_corriente = TRUE
      AND estado = 'completada'
      AND MONTH(fecha_venta) = MONTH(CURRENT_DATE())
      AND YEAR(fecha_venta) = YEAR(CURRENT_DATE())
    `)

    // Convertir fechas a ISO
    const cuentasConFecha = cuentas.map((cuenta) => ({
      ...cuenta,
      fecha_actualizacion: cuenta.fecha_actualizacion.toISOString(),
      ultima_actividad: cuenta.ultima_actividad ? cuenta.ultima_actividad.toISOString() : null,
    }))

    res.status(200).json({
      cuentas: cuentasConFecha,
      resumen: {
        ...totales[0],
        pagos_mes_actual: pagosMes[0],
        ventas_mes_actual: ventasMes[0],
      },
    })
  } catch (error) {
    console.error("Error al obtener resumen de cuenta corriente:", error)
    res.status(500).json({ message: "Error al obtener resumen de cuenta corriente" })
  }
}

// Crear ajuste manual de cuenta corriente
export const crearAjuste = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const {
      cliente_id,
      tipo, // 'debito' o 'credito'
      monto,
      concepto,
      notas = "",
    } = req.body

    // Validar que el monto sea positivo
    if (monto <= 0) {
      await connection.rollback()
      return res.status(400).json({ message: "El monto debe ser mayor a 0" })
    }

    // Validar que el cliente existe y tiene cuenta corriente
    const [clientData] = await connection.query(
      `SELECT 
        c.id, 
        c.nombre, 
        c.tiene_cuenta_corriente,
        c.saldo_cuenta_corriente,
        c.limite_credito
      FROM clientes c
      WHERE c.id = ? AND c.activo = TRUE AND c.tiene_cuenta_corriente = TRUE`,
      [cliente_id],
    )

    if (clientData.length === 0) {
      await connection.rollback()
      return res.status(404).json({ message: "Cliente no encontrado o no tiene cuenta corriente activa" })
    }

    const cliente = clientData[0]

    const saldoAnterior = cliente.saldo_cuenta_corriente
    let nuevoSaldo

    // Calcular nuevo saldo según el tipo de ajuste
    if (tipo === "debito") {
      // Débito aumenta la deuda (suma al saldo)
      nuevoSaldo = saldoAnterior + monto

      // Verificar límite de crédito si existe
      if (cliente.limite_credito && nuevoSaldo > cliente.limite_credito) {
        await connection.rollback()
        return res.status(400).json({
          message: `El ajuste excede el límite de crédito. Límite: $${cliente.limite_credito.toFixed(2)}, Saldo actual: $${saldoAnterior.toFixed(2)}, Monto del ajuste: $${monto.toFixed(2)}`,
        })
      }
    } else {
      // Crédito disminuye la deuda (resta del saldo)
      nuevoSaldo = Math.max(0, saldoAnterior - monto)
    }

    // Actualizar saldo de la cuenta corriente
    await connection.query("UPDATE clientes SET saldo_cuenta_corriente = ROUND(?, 2) WHERE id = ?", [
      nuevoSaldo,
      cliente_id,
    ])

    // Crear movimiento de cuenta corriente
    const conceptoMovimiento = tipo === "debito" ? "nota_debito" : "nota_credito"
    const [movimientoResult] = await connection.query(
      `
      INSERT INTO movimientos_cuenta_corriente (
        cliente_id, usuario_id, tipo, concepto,
        monto, saldo_anterior, saldo_nuevo, referencia_tipo,
        descripcion
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ajuste', ?)
    `,
      [
        cliente_id,
        req.user.id,
        tipo,
        conceptoMovimiento,
        monto,
        saldoAnterior,
        nuevoSaldo,
        `Ajuste ${tipo}: ${concepto}${notas ? " - " + notas : ""}`,
      ],
    )

    await connection.commit()

    res.status(201).json({
      message: "Ajuste registrado exitosamente",
      data: {
        id: movimientoResult.insertId,
        tipo,
        monto,
        saldoAnterior,
        nuevoSaldo,
        cliente: cliente.nombre,
      },
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al crear ajuste:", error)
    res.status(500).json({ message: error.message || "Error al crear ajuste" })
  } finally {
    connection.release()
  }
}

// Anular un pago de cuenta corriente
export const anularPago = async (req, res) => {
  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const { id } = req.params
    const { motivo = "" } = req.body

    // Verificar que el pago existe y está activo
    const [pagos] = await connection.query(
      `SELECT 
        p.*,
        c.nombre as cliente_nombre,
        c.saldo_cuenta_corriente,
        c.limite_credito
      FROM pagos_cuenta_corriente p
      JOIN clientes c ON p.cliente_id = c.id
      WHERE p.id = ? AND p.estado = 'activo'`,
      [id],
    )

    if (pagos.length === 0) {
      await connection.rollback()
      return res.status(404).json({ message: "Pago no encontrado o ya está anulado" })
    }

    const pago = pagos[0]

    // Obtener el saldo actual con FOR UPDATE
    const [saldoActualResult] = await connection.query(
      "SELECT saldo_cuenta_corriente FROM clientes WHERE id = ? FOR UPDATE",
      [pago.cliente_id],
    )

    const saldoAnterior = saldoActualResult[0].saldo_cuenta_corriente
    const nuevoSaldo = saldoAnterior + pago.monto // Revertir el pago (aumentar deuda)

    // Verificar límite de crédito si existe
    if (pago.limite_credito && nuevoSaldo > pago.limite_credito) {
      await connection.rollback()
      return res.status(400).json({
        message: `La anulación del pago excedería el límite de crédito. Límite: $${pago.limite_credito.toFixed(2)}, Saldo resultante: $${nuevoSaldo.toFixed(2)}`,
      })
    }

    // Actualizar saldo de la cuenta corriente
    await connection.query("UPDATE clientes SET saldo_cuenta_corriente = ROUND(?, 2) WHERE id = ?", [
      nuevoSaldo,
      pago.cliente_id,
    ])

    // Crear movimiento de reversión
    await connection.query(
      `
      INSERT INTO movimientos_cuenta_corriente (
        cliente_id, usuario_id, tipo, concepto,
        monto, saldo_anterior, saldo_nuevo, referencia_id, referencia_tipo,
        numero_referencia, descripcion
      ) VALUES (?, ?, 'debito', 'nota_debito', ?, ?, ?, ?, 'anulacion_pago', ?, ?)
    `,
      [
        pago.cliente_id,
        req.user.id,
        pago.monto,
        saldoAnterior,
        nuevoSaldo,
        id,
        pago.numero_recibo,
        `Anulación pago ${pago.numero_recibo} - Motivo: ${motivo}`,
      ],
    )

    // Marcar el pago como anulado
    await connection.query(
      "UPDATE pagos_cuenta_corriente SET estado = 'anulado', observaciones = CONCAT(COALESCE(observaciones, ''), ' - ANULADO: ', ?) WHERE id = ?",
      [motivo, id],
    )

    await connection.commit()

    res.status(200).json({
      message: "Pago anulado exitosamente",
      data: {
        id,
        numeroRecibo: pago.numero_recibo,
        cliente: pago.cliente_nombre,
        monto: pago.monto,
        saldoAnterior,
        nuevoSaldo,
        motivo,
      },
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al anular pago:", error)
    res.status(500).json({ message: error.message || "Error al anular pago" })
  } finally {
    connection.release()
  }
}

// Obtener movimientos de cuenta corriente de un cliente
export const getMovimientosByClient = async (req, res) => {
  try {
    const { clientId } = req.params
    const { limit = 50, offset = 0, tipo = "", concepto = "" } = req.query

    // Verificar que el cliente existe
    const [client] = await pool.query(
      "SELECT id, nombre, tiene_cuenta_corriente, saldo_cuenta_corriente FROM clientes WHERE id = ? AND activo = TRUE",
      [clientId],
    )

    if (client.length === 0) {
      return res.status(404).json({ message: "Cliente no encontrado" })
    }

    if (!client[0].tiene_cuenta_corriente) {
      return res.status(400).json({ message: "El cliente no tiene cuenta corriente habilitada" })
    }

    let query = `
      SELECT 
        m.*,
        u.nombre as usuario_nombre
      FROM movimientos_cuenta_corriente m
      JOIN usuarios u ON m.usuario_id = u.id
      WHERE m.cliente_id = ?
    `

    const queryParams = [clientId]

    if (tipo && tipo !== "todos") {
      query += ` AND m.tipo = ?`
      queryParams.push(tipo)
    }

    if (concepto && concepto !== "todos") {
      query += ` AND m.concepto = ?`
      queryParams.push(concepto)
    }

    query += ` ORDER BY m.fecha_movimiento DESC, m.id DESC LIMIT ? OFFSET ?`
    queryParams.push(Number.parseInt(limit), Number.parseInt(offset))

    const [movimientos] = await pool.query(query, queryParams)

    // Convertir fechas a ISO
    const movimientosConFecha = movimientos.map((mov) => ({
      ...mov,
      fecha_movimiento: mov.fecha_movimiento.toISOString(),
    }))

    res.status(200).json({
      cliente: client[0],
      movimientos: movimientosConFecha,
    })
  } catch (error) {
    console.error("Error al obtener movimientos:", error)
    res.status(500).json({ message: "Error al obtener movimientos de cuenta corriente" })
  }
}

// Obtener estadísticas de cuenta corriente
export const getEstadisticasCuentaCorriente = async (req, res) => {
  try {
    const { fechaInicio = "", fechaFin = "" } = req.query

    let whereClause = "WHERE 1=1"
    const queryParams = []

    if (fechaInicio) {
      whereClause += " AND DATE(fecha_movimiento) >= ?"
      queryParams.push(fechaInicio)
    }

    if (fechaFin) {
      whereClause += " AND DATE(fecha_movimiento) <= ?"
      queryParams.push(fechaFin)
    }

    // Movimientos por tipo
    const [movimientosPorTipo] = await pool.query(
      `
      SELECT 
        tipo,
        concepto,
        COUNT(*) as cantidad,
        SUM(monto) as total
      FROM movimientos_cuenta_corriente
      ${whereClause}
      GROUP BY tipo, concepto
      ORDER BY tipo, concepto
    `,
      queryParams,
    )

    // Evolución de saldos por día
    const [evolucionSaldos] = await pool.query(
      `
      SELECT 
        DATE(fecha_movimiento) as fecha,
        SUM(CASE WHEN tipo = 'debito' THEN monto ELSE -monto END) as variacion_dia
      FROM movimientos_cuenta_corriente
      ${whereClause}
      GROUP BY DATE(fecha_movimiento)
      ORDER BY fecha DESC
      LIMIT 30
    `,
      queryParams,
    )

    // Clientes con mayor deuda
    const [clientesMayorDeuda] = await pool.query(`
      SELECT 
        c.id,
        c.nombre,
        c.saldo_cuenta_corriente as saldo_actual,
        c.limite_credito,
        CASE 
          WHEN c.limite_credito IS NULL THEN 999999999
          ELSE GREATEST(0, c.limite_credito - c.saldo_cuenta_corriente)
        END as saldo_disponible
      FROM clientes c
      WHERE c.activo = TRUE AND c.tiene_cuenta_corriente = TRUE AND c.saldo_cuenta_corriente > 0.01
      ORDER BY c.saldo_cuenta_corriente DESC
      LIMIT 10
    `)

    // Estadísticas de pagos por tipo
    const [pagosPorTipo] = await pool.query(
      `
      SELECT 
        tipo_pago,
        COUNT(*) as cantidad,
        SUM(monto) as total_monto
      FROM pagos_cuenta_corriente p
      WHERE p.estado = 'activo'
      ${fechaInicio ? "AND DATE(p.fecha_pago) >= ?" : ""}
      ${fechaFin ? "AND DATE(p.fecha_pago) <= ?" : ""}
      GROUP BY tipo_pago
      ORDER BY total_monto DESC
    `,
      [...(fechaInicio ? [fechaInicio] : []), ...(fechaFin ? [fechaFin] : [])],
    )

    res.status(200).json({
      movimientosPorTipo,
      evolucionSaldos: evolucionSaldos.map((item) => ({
        ...item,
        fecha: item.fecha.toISOString().split("T")[0],
      })),
      clientesMayorDeuda,
      pagosPorTipo,
    })
  } catch (error) {
    console.error("Error al obtener estadísticas:", error)
    res.status(500).json({ message: "Error al obtener estadísticas de cuenta corriente" })
  }
}
