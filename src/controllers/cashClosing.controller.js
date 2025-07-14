import pool from "../db.js"
import { validationResult } from "express-validator"

// Helper para actualizar la última fecha y hora de cierre de caja
const updateLastCashClosingDateTime = async (connection, newDateTime) => {
  await connection.query("UPDATE configuracion SET valor = ? WHERE clave = 'ultima_fecha_hora_cierre_caja'", [
    newDateTime,
  ])
}

// Obtener datos para el cierre de caja pendiente (desde el último cierre hasta ahora)
export const getPendingCashClosingData = async (req, res) => {
  const connection = await pool.getConnection()
  try {
    const { fechaInicio, horaInicio, fechaFin, horaFin, tipoCierre } = req.query

    const startDateTime = `${fechaInicio} ${horaInicio}`
    const endDateTime = `${fechaFin} ${horaFin}`

    // Obtener pagos de ventas en el período
    const [salesPayments] = await connection.query(
      `
      SELECT vp.tipo_pago, SUM(vp.monto) as total_monto, COUNT(*) as cantidad_transacciones
      FROM venta_pagos vp
      JOIN ventas v ON vp.venta_id = v.id
      WHERE v.fecha_creacion >= ? AND v.fecha_creacion <= ? AND v.estado = 'completada'
      GROUP BY vp.tipo_pago
    `,
      [startDateTime, endDateTime],
    )

    // CAMBIO IMPORTANTE: Usar fecha_creacion para pagos de clientes a cuenta corriente
    const [clientPayments] = await connection.query(
      `
      SELECT pcc.tipo_pago, SUM(pcc.monto) as total_monto, COUNT(*) as cantidad_transacciones
      FROM pagos_cuenta_corriente pcc
      WHERE pcc.fecha_creacion >= ? AND pcc.fecha_creacion <= ? AND pcc.estado = 'activo'
      GROUP BY pcc.tipo_pago
    `,
      [startDateTime, endDateTime],
    )

    let purchasePayments = []
    if (tipoCierre === "full") {
      // Obtener pagos de compras en el período (solo si es cierre 'full')
      ;[purchasePayments] = await connection.query(
        `
        SELECT cp.tipo_pago, SUM(cp.monto) as total_monto, COUNT(*) as cantidad_transacciones
        FROM compra_pagos cp
        JOIN compras c ON cp.compra_id = c.id
        WHERE c.fecha_creacion >= ? AND c.fecha_creacion <= ? AND c.estado != 'cancelada'
        GROUP BY cp.tipo_pago
      `,
        [startDateTime, endDateTime],
      )
    }

    // Calcular totales
    let totalVentas = 0
    let totalCompras = 0
    let ingresosEfectivo = 0
    let egresosEfectivo = 0

    salesPayments.forEach((p) => {
      totalVentas += Number.parseFloat(p.total_monto)
      if (p.tipo_pago === "efectivo") ingresosEfectivo += Number.parseFloat(p.total_monto)
    })

    clientPayments.forEach((p) => {
      if (p.tipo_pago === "efectivo") ingresosEfectivo += Number.parseFloat(p.total_monto)
    })

    purchasePayments.forEach((p) => {
      totalCompras += Number.parseFloat(p.total_monto)
      if (p.tipo_pago === "efectivo") egresosEfectivo += Number.parseFloat(p.total_monto)
    })

    res.status(200).json({
      success: true,
      data: {
        fechaInicio: fechaInicio,
        horaInicio: horaInicio,
        fechaFin: fechaFin,
        horaFin: horaFin,
        totalVentas: totalVentas,
        totalCompras: totalCompras,
        ingresosEfectivo: ingresosEfectivo,
        egresosEfectivo: egresosEfectivo,
        detallesPagosVentas: salesPayments,
        detallesPagosCompras: purchasePayments,
        detallesPagosClientes: clientPayments,
        isAlreadyClosedToday: false,
      },
    })
  } catch (error) {
    console.error("Error al obtener datos para cierre de caja:", error)
    res.status(500).json({ message: "Error al obtener datos para cierre de caja" })
  } finally {
    connection.release()
  }
}

// Realizar un cierre de caja
export const createCashClosing = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const { saldoInicialCaja, fechaCierre, horaCierre, observaciones, detalles, tipoCierre } = req.body
    const userId = req.user.id
    const fechaHoraCierre = `${fechaCierre} ${horaCierre}`

    // Calcular totales de ingresos y egresos en efectivo de los detalles
    let totalIngresosEfectivo = 0
    let totalEgresosEfectivo = 0
    let totalVentas = 0
    let totalCompras = 0

    detalles.forEach((d) => {
      if (
        d.tipo_movimiento === "venta" ||
        d.tipo_movimiento === "pago_cliente" ||
        d.tipo_movimiento === "ajuste_ingreso"
      ) {
        totalVentas += d.monto
        if (d.metodo_pago === "efectivo") {
          totalIngresosEfectivo += d.monto
        }
      } else if (d.tipo_movimiento === "compra" || d.tipo_movimiento === "ajuste_egreso") {
        totalCompras += d.monto
        if (d.metodo_pago === "efectivo") {
          totalEgresosEfectivo += d.monto
        }
      }
    })

    // Calcular saldo final y diferencia
    const saldoFinalCaja = saldoInicialCaja + totalIngresosEfectivo - totalEgresosEfectivo
    const diferencia = saldoFinalCaja - (saldoInicialCaja + totalIngresosEfectivo - totalEgresosEfectivo) // Debería ser 0 si todo cuadra

    const [cierreResult] = await connection.query(
      `
      INSERT INTO cierres_caja (
        usuario_id, fecha_hora_cierre, saldo_inicial_caja, saldo_final_caja,
        total_ventas, total_compras, total_ingresos_efectivo, total_egresos_efectivo,
        diferencia, observaciones, tipo_cierre
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        userId,
        fechaHoraCierre,
        saldoInicialCaja,
        saldoFinalCaja,
        totalVentas,
        totalCompras,
        totalIngresosEfectivo,
        totalEgresosEfectivo,
        diferencia,
        observaciones,
        tipoCierre,
      ],
    )

    const cierreId = cierreResult.insertId

    for (const detalle of detalles) {
      await connection.query(
        `
        INSERT INTO cierres_caja_detalles (
          cierre_id, tipo_movimiento, metodo_pago, monto, cantidad_transacciones, descripcion
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
        [
          cierreId,
          detalle.tipo_movimiento,
          detalle.metodo_pago,
          detalle.monto,
          detalle.cantidad_transacciones || 1,
          detalle.descripcion || null,
        ],
      )
    }

    // Actualizar la última fecha y hora de cierre en la configuración
    await updateLastCashClosingDateTime(connection, fechaHoraCierre)

    await connection.commit()

    res.status(201).json({
      success: true,
      message: "Cierre de caja realizado exitosamente",
      data: { id: cierreId, fechaHoraCierre, saldoFinalCaja },
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al crear cierre de caja:", error)
    res.status(500).json({ message: error.message || "Error al crear cierre de caja" })
  } finally {
    connection.release()
  }
}

// Obtener historial de cierres de caja
export const getCashClosings = async (req, res) => {
  try {
    const { fechaInicio = "", fechaFin = "", usuarioId = "", tipoCierre = "", limit = 10, offset = 0 } = req.query

    let query = `
      SELECT
        cc.*,
        u.nombre as usuario_nombre
      FROM cierres_caja cc
      JOIN usuarios u ON cc.usuario_id = u.id
      WHERE 1=1
    `
    const queryParams = []

    if (fechaInicio) {
      query += ` AND DATE(cc.fecha_hora_cierre) >= ?`
      queryParams.push(fechaInicio)
    }
    if (fechaFin) {
      query += ` AND DATE(cc.fecha_hora_cierre) <= ?`
      queryParams.push(fechaFin)
    }
    if (usuarioId) {
      query += ` AND cc.usuario_id = ?`
      queryParams.push(usuarioId)
    }
    if (tipoCierre) {
      query += ` AND cc.tipo_cierre = ?`
      queryParams.push(tipoCierre)
    }

    query += ` ORDER BY cc.fecha_hora_cierre DESC LIMIT ? OFFSET ?`
    queryParams.push(Number.parseInt(limit), Number.parseInt(offset))

    const [closings] = await pool.query(query, queryParams)

    const formattedClosings = closings.map((c) => ({
      ...c,
      fecha_cierre: c.fecha_hora_cierre.toISOString().split("T")[0],
      hora_cierre: c.fecha_hora_cierre.toISOString().split("T")[1].substring(0, 5), // HH:MM
      fecha_creacion: c.fecha_creacion.toISOString(),
      fecha_actualizacion: c.fecha_actualizacion.toISOString(),
    }))

    res.status(200).json({
      success: true,
      data: formattedClosings,
    })
  } catch (error) {
    console.error("Error al obtener cierres de caja:", error)
    res.status(500).json({ message: "Error al obtener historial de cierres de caja" })
  }
}

// Obtener detalles de un cierre de caja por ID
export const getCashClosingById = async (req, res) => {
  try {
    const { id } = req.params

    const [closings] = await pool.query(
      `
      SELECT
        cc.*,
        u.nombre as usuario_nombre
      FROM cierres_caja cc
      JOIN usuarios u ON cc.usuario_id = u.id
      WHERE cc.id = ?
    `,
      [id],
    )

    if (closings.length === 0) {
      return res.status(404).json({ message: "Cierre de caja no encontrado" })
    }

    const closing = closings[0]

    const [details] = await pool.query(
      `
      SELECT *
      FROM cierres_caja_detalles
      WHERE cierre_id = ?
      ORDER BY tipo_movimiento, metodo_pago
    `,
      [id],
    )

    const formattedClosing = {
      ...closing,
      fecha_cierre: closing.fecha_hora_cierre.toISOString().split("T")[0],
      hora_cierre: closing.fecha_hora_cierre.toISOString().split("T")[1].substring(0, 5), // HH:MM
      fecha_creacion: closing.fecha_creacion.toISOString(),
      fecha_actualizacion: closing.fecha_actualizacion.toISOString(),
      detalles: details.map((d) => ({
        ...d,
        fecha_creacion: d.fecha_creacion.toISOString(),
      })),
    }

    res.status(200).json({
      success: true,
      data: formattedClosing,
    })
  } catch (error) {
    console.error("Error al obtener cierre de caja por ID:", error)
    res.status(500).json({ message: "Error al obtener detalles del cierre de caja" })
  }
}
