import pool from "../db.js"
import { validationResult } from "express-validator"

// Obtener resumen de ventas del día para cierre
export const getDailySalesSummary = async (req, res) => {
  try {
    const { fecha } = req.query
    const targetDate = fecha || new Date().toISOString().split("T")[0]

    // Obtener ventas del día agrupadas por método de pago
    const [salesByPayment] = await pool.query(
      `
      SELECT 
        tipo_pago,
        COUNT(*) as cantidad_ventas,
        SUM(total) as total_monto,
        SUM(descuento) as total_descuentos
      FROM ventas 
      WHERE DATE(fecha_venta) = ? AND estado = 'completada'
      GROUP BY tipo_pago
      ORDER BY tipo_pago
    `,
      [targetDate],
    )

    // Obtener total general del día
    const [totalDay] = await pool.query(
      `
      SELECT 
        COUNT(*) as total_ventas,
        SUM(total) as monto_total,
        SUM(descuento) as descuentos_total,
        SUM(subtotal) as subtotal_total
      FROM ventas 
      WHERE DATE(fecha_venta) = ? AND estado = 'completada'
    `,
      [targetDate],
    )

    // Verificar si ya existe un cierre para esta fecha
    const [existingClosing] = await pool.query(
      `
      SELECT id FROM cierres_caja 
      WHERE DATE(fecha_cierre) = ?
    `,
      [targetDate],
    )

    res.status(200).json({
      fecha: targetDate,
      ventasPorTipoPago: salesByPayment,
      resumenTotal: totalDay[0] || {
        total_ventas: 0,
        monto_total: 0,
        descuentos_total: 0,
        subtotal_total: 0,
      },
      yaExisteCierre: existingClosing.length > 0,
    })
  } catch (error) {
    console.error("Error al obtener resumen de ventas:", error)
    res.status(500).json({ message: "Error al obtener resumen de ventas" })
  }
}

// Crear un nuevo cierre de caja
export const createCashClosing = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const { fechaCierre, efectivoEnCaja, observaciones = null } = req.body

    const targetDate = fechaCierre || new Date().toISOString().split("T")[0]

    // Verificar si ya existe un cierre para esta fecha
    const [existingClosing] = await connection.query(
      `
      SELECT id FROM cierres_caja 
      WHERE DATE(fecha_cierre) = ?
    `,
      [targetDate],
    )

    if (existingClosing.length > 0) {
      await connection.rollback()
      return res.status(400).json({
        message: "Ya existe un cierre de caja para esta fecha",
      })
    }

    // Obtener resumen de ventas del día
    const [salesSummary] = await connection.query(
      `
      SELECT 
        COUNT(*) as total_ventas,
        SUM(total) as monto_total,
        SUM(descuento) as descuentos_total,
        SUM(subtotal) as subtotal_total
      FROM ventas 
      WHERE DATE(fecha_venta) = ? AND estado = 'completada'
    `,
      [targetDate],
    )

    const summary = salesSummary[0] || {
      total_ventas: 0,
      monto_total: 0,
      descuentos_total: 0,
      subtotal_total: 0,
    }

    // Obtener ventas por método de pago
    const [salesByPayment] = await connection.query(
      `
      SELECT 
        tipo_pago,
        COUNT(*) as cantidad_ventas,
        SUM(total) as total_monto
      FROM ventas 
      WHERE DATE(fecha_venta) = ? AND estado = 'completada'
      GROUP BY tipo_pago
    `,
      [targetDate],
    )

    // Calcular efectivo esperado (solo ventas en efectivo)
    const efectivoEsperado = salesByPayment
      .filter((item) => item.tipo_pago === "efectivo")
      .reduce((sum, item) => sum + Number.parseFloat(item.total_monto || 0), 0)

    const diferencia = Number.parseFloat(efectivoEnCaja) - efectivoEsperado

    // Crear el cierre de caja
    const [result] = await connection.query(
      `
      INSERT INTO cierres_caja (
        fecha_cierre, usuario_id, total_ventas, monto_total_ventas,
        efectivo_esperado, efectivo_en_caja, diferencia,
        observaciones, detalles_ventas
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        targetDate,
        req.user.id,
        summary.total_ventas,
        summary.monto_total,
        efectivoEsperado,
        efectivoEnCaja,
        diferencia,
        observaciones,
        JSON.stringify(salesByPayment),
      ],
    )

    await connection.commit()

    res.status(201).json({
      message: "Cierre de caja creado exitosamente",
      id: result.insertId,
      diferencia: diferencia,
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al crear cierre de caja:", error)
    res.status(500).json({ message: "Error al crear cierre de caja" })
  } finally {
    connection.release()
  }
}

// Obtener todos los cierres de caja con filtros
export const getCashClosings = async (req, res) => {
  try {
    const { fechaInicio = "", fechaFin = "", usuario = "", sortBy = "fecha_cierre", sortOrder = "desc" } = req.query

    let query = `
      SELECT 
        cc.id,
        cc.fecha_cierre,
        cc.total_ventas,
        cc.monto_total_ventas,
        cc.efectivo_esperado,
        cc.efectivo_en_caja,
        cc.diferencia,
        cc.observaciones,
        cc.fecha_creacion,
        u.nombre as usuario_nombre
      FROM cierres_caja cc
      LEFT JOIN usuarios u ON cc.usuario_id = u.id
      WHERE 1=1
    `

    const queryParams = []

    // Filtros
    if (fechaInicio) {
      query += ` AND DATE(cc.fecha_cierre) >= ?`
      queryParams.push(fechaInicio)
    }

    if (fechaFin) {
      query += ` AND DATE(cc.fecha_cierre) <= ?`
      queryParams.push(fechaFin)
    }

    if (usuario) {
      query += ` AND u.nombre LIKE ?`
      queryParams.push(`%${usuario}%`)
    }

    // Ordenamiento
    const validSortFields = ["fecha_cierre", "monto_total_ventas", "diferencia", "usuario_nombre"]
    const validSortOrders = ["asc", "desc"]

    if (validSortFields.includes(sortBy) && validSortOrders.includes(sortOrder)) {
      if (sortBy === "usuario_nombre") {
        query += ` ORDER BY u.nombre ${sortOrder}`
      } else {
        query += ` ORDER BY cc.${sortBy} ${sortOrder}`
      }
    }

    const [closings] = await pool.query(query, queryParams)

    // Convertir fechas a ISO
    const closingsWithDates = closings.map((closing) => ({
      ...closing,
      fecha_cierre: closing.fecha_cierre.toISOString(),
      fecha_creacion: closing.fecha_creacion.toISOString(),
    }))

    res.status(200).json(closingsWithDates)
  } catch (error) {
    console.error("Error al obtener cierres de caja:", error)
    res.status(500).json({ message: "Error al obtener cierres de caja" })
  }
}

// Obtener un cierre de caja por ID
export const getCashClosingById = async (req, res) => {
  try {
    const { id } = req.params

    const [closings] = await pool.query(
      `
      SELECT 
        cc.id,
        cc.fecha_cierre,
        cc.total_ventas,
        cc.monto_total_ventas,
        cc.efectivo_esperado,
        cc.efectivo_en_caja,
        cc.diferencia,
        cc.observaciones,
        cc.detalles_ventas,
        cc.fecha_creacion,
        u.nombre as usuario_nombre
      FROM cierres_caja cc
      LEFT JOIN usuarios u ON cc.usuario_id = u.id
      WHERE cc.id = ?
    `,
      [id],
    )

    if (closings.length === 0) {
      return res.status(404).json({ message: "Cierre de caja no encontrado" })
    }

    const closing = closings[0]

    // Parsear detalles de ventas
    if (closing.detalles_ventas) {
      try {
        closing.detalles_ventas = JSON.parse(closing.detalles_ventas)
      } catch (e) {
        closing.detalles_ventas = []
      }
    }

    // Convertir fechas
    closing.fecha_cierre = closing.fecha_cierre.toISOString()
    closing.fecha_creacion = closing.fecha_creacion.toISOString()

    res.status(200).json(closing)
  } catch (error) {
    console.error("Error al obtener cierre de caja:", error)
    res.status(500).json({ message: "Error al obtener cierre de caja" })
  }
}

// Obtener estadísticas de cierres de caja
export const getCashClosingStats = async (req, res) => {
  try {
    const { fechaInicio = "", fechaFin = "" } = req.query

    let dateFilter = ""
    const queryParams = []

    if (fechaInicio && fechaFin) {
      dateFilter = "WHERE DATE(fecha_cierre) BETWEEN ? AND ?"
      queryParams.push(fechaInicio, fechaFin)
    } else if (fechaInicio) {
      dateFilter = "WHERE DATE(fecha_cierre) >= ?"
      queryParams.push(fechaInicio)
    } else if (fechaFin) {
      dateFilter = "WHERE DATE(fecha_cierre) <= ?"
      queryParams.push(fechaFin)
    }

    // Estadísticas generales
    const [stats] = await pool.query(
      `
      SELECT 
        COUNT(*) as total_cierres,
        SUM(monto_total_ventas) as monto_total,
        AVG(monto_total_ventas) as promedio_ventas,
        SUM(ABS(diferencia)) as total_diferencias,
        SUM(CASE WHEN diferencia > 0 THEN diferencia ELSE 0 END) as sobrantes_total,
        SUM(CASE WHEN diferencia < 0 THEN ABS(diferencia) ELSE 0 END) as faltantes_total
      FROM cierres_caja 
      ${dateFilter}
    `,
      queryParams,
    )

    res.status(200).json(
      stats[0] || {
        total_cierres: 0,
        monto_total: 0,
        promedio_ventas: 0,
        total_diferencias: 0,
        sobrantes_total: 0,
        faltantes_total: 0,
      },
    )
  } catch (error) {
    console.error("Error al obtener estadísticas:", error)
    res.status(500).json({ message: "Error al obtener estadísticas" })
  }
}
