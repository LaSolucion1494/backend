// cotizaciones.controller.js
import pool from "../db.js"
import { validationResult } from "express-validator"

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

// Función para generar el próximo número de cotización
const generateCotizacionNumber = async (connection) => {
  try {
    const [config] = await connection.query(`
      SELECT clave, valor FROM configuracion 
      WHERE clave IN ('cotizacion_numero_siguiente', 'cotizacion_prefijo')
      FOR UPDATE
    `)

    if (config.length === 0) {
      throw new Error("No se encontró configuración de numeración de cotizaciones")
    }

    const configObj = {}
    config.forEach((item) => {
      configObj[item.clave] = item.valor
    })

    if (!configObj.cotizacion_numero_siguiente) {
      throw new Error("No se encontró el próximo número de cotización en la configuración")
    }

    const nextNumber = Number.parseInt(configObj.cotizacion_numero_siguiente)
    if (isNaN(nextNumber) || nextNumber < 1) {
      throw new Error(`Número de cotización inválido en configuración: ${configObj.cotizacion_numero_siguiente}`)
    }

    const prefix = configObj.cotizacion_prefijo || "COT-"
    const cotizacionNumber = `${prefix}${nextNumber.toString().padStart(6, "0")}`

    const [updateResult] = await connection.query(
      "UPDATE configuracion SET valor = ? WHERE clave = 'cotizacion_numero_siguiente'",
      [(nextNumber + 1).toString()],
    )

    if (updateResult.affectedRows === 0) {
      throw new Error("No se pudo actualizar el contador de cotizaciones")
    }

    return cotizacionNumber
  } catch (error) {
    console.error("Error al generar número de cotización:", error)
    throw new Error(`Error al generar número de cotización: ${error.message}`)
  }
}

// Crear una nueva cotización
export const createCotizacion = async (req, res) => {
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
      condicionesComerciales = "",
      tiempoEntrega = "",
      fechaCotizacion,
      fechaVencimiento,
      validezDias = 30,
    } = req.body

    if (!productos || productos.length === 0) {
      await connection.rollback()
      return res.status(400).json({ message: "Debe incluir al menos un producto" })
    }

    // Obtener datos de la empresa
    const empresaDatos = await getCompanyDataFromConfig(connection)

    // Verificar que el cliente existe
    const [clienteData] = await connection.query(
      `SELECT 
        c.id, 
        c.nombre, 
        c.telefono,
        c.email,
        c.direccion,
        c.cuit
      FROM clientes c
      WHERE c.id = ? AND c.activo = TRUE`,
      [clienteId],
    )

    if (clienteData.length === 0) {
      await connection.rollback()
      return res.status(404).json({ message: "Cliente no encontrado" })
    }

    const cliente = clienteData[0]

    // Generar número de cotización
    const numeroCotizacion = await generateCotizacionNumber(connection)

    if (!numeroCotizacion) {
      await connection.rollback()
      return res.status(500).json({ message: "Error al generar número de cotización" })
    }

    let subtotal = 0
    const productsToProcess = []

    // Procesar productos (SIN AFECTAR STOCK)
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
      const cantidad = Number.parseInt(item.cantidad)
      const precioUnitario = Number.parseFloat(item.precioUnitario || prod.precio_venta)
      const subtotalItem = precioUnitario * cantidad
      const discountPercentage = Number.parseFloat(item.discount_percentage || 0)

      productsToProcess.push({
        ...item,
        nombre: prod.nombre,
        precioUnitario,
        cantidad,
        subtotalItem,
        discount_percentage: discountPercentage,
        descripcion_personalizada: item.descripcion_personalizada || null,
      })

      subtotal += subtotalItem
    }

    const descuentoNum = Number.parseFloat(descuento)
    const interesNum = Number.parseFloat(interes)
    const total = subtotal - descuentoNum + interesNum

    // Calcular fecha de vencimiento si no se proporciona
    let fechaVenc = fechaVencimiento
    if (!fechaVenc && validezDias) {
      const fechaCot = new Date(fechaCotizacion)
      fechaCot.setDate(fechaCot.getDate() + validezDias)
      fechaVenc = fechaCot.toISOString().split("T")[0]
    }

    // Obtener configuraciones por defecto
    const [defaultConfig] = await connection.query(`
      SELECT clave, valor FROM configuracion 
      WHERE clave IN ('cotizacion_tiempo_entrega_default', 'cotizacion_validez_default')
    `)

    const configDefaults = {}
    defaultConfig.forEach((item) => {
      configDefaults[item.clave] = item.valor
    })

    const tiempoEntregaFinal = tiempoEntrega || configDefaults.cotizacion_tiempo_entrega_default || "7-10 días hábiles"

    // Insertar cotización
    const [cotizacionResult] = await connection.query(
      `
      INSERT INTO cotizaciones (
        numero_cotizacion, cliente_id, usuario_id, fecha_cotizacion, fecha_vencimiento,
        subtotal, descuento, interes, total, observaciones, condiciones_comerciales,
        tiempo_entrega, validez_dias, empresa_datos, estado
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'activa')
    `,
      [
        numeroCotizacion,
        clienteId,
        req.user.id,
        fechaCotizacion,
        fechaVenc,
        subtotal,
        descuentoNum,
        interesNum,
        total,
        observaciones,
        condicionesComerciales,
        tiempoEntregaFinal,
        validezDias,
        JSON.stringify(empresaDatos),
      ],
    )

    const cotizacionId = cotizacionResult.insertId

    // Insertar detalles de cotización
    for (const item of productsToProcess) {
      await connection.query(
        `INSERT INTO detalles_cotizaciones (
          cotizacion_id, producto_id, cantidad, precio_unitario, subtotal, 
          discount_percentage, descripcion_personalizada
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          cotizacionId,
          item.productoId,
          item.cantidad,
          item.precioUnitario,
          item.subtotalItem,
          item.discount_percentage,
          item.descripcion_personalizada,
        ],
      )
    }

    await connection.commit()

    res.status(201).json({
      message: "Cotización creada exitosamente",
      data: {
        id: cotizacionId,
        numeroCotizacion: numeroCotizacion,
        total,
        fechaVencimiento: fechaVenc,
        empresaDatos,
        cliente: cliente,
      },
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al crear cotización:", error)
    res.status(500).json({
      message: error.message || "Error al crear cotización",
      details: error.stack,
    })
  } finally {
    connection.release()
  }
}

// Obtener una cotización por ID
export const getCotizacionById = async (req, res) => {
  try {
    const { id } = req.params

    const [cotizaciones] = await pool.query(
      `
      SELECT 
        c.*,
        cl.nombre as cliente_nombre,
        cl.telefono as cliente_telefono,
        cl.email as cliente_email,
        cl.direccion as cliente_direccion,
        cl.cuit as cliente_cuit,
        u.nombre as usuario_nombre
      FROM cotizaciones c
      JOIN clientes cl ON c.cliente_id = cl.id
      JOIN usuarios u ON c.usuario_id = u.id
      WHERE c.id = ?
    `,
      [id],
    )

    if (cotizaciones.length === 0) {
      return res.status(404).json({ message: "Cotización no encontrada" })
    }

    const cotizacion = cotizaciones[0]

    // Parsear datos de empresa
    let empresaDatos = null
    if (cotizacion.empresa_datos) {
      try {
        empresaDatos = JSON.parse(cotizacion.empresa_datos)
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

    // Obtener detalles
    const [details] = await pool.query(
      `
      SELECT 
        dc.*,
        p.nombre as producto_nombre,
        p.codigo as producto_codigo,
        p.marca as producto_marca,
        p.stock as producto_stock_actual
      FROM detalles_cotizaciones dc
      JOIN productos p ON dc.producto_id = p.id
      WHERE dc.cotizacion_id = ?
      ORDER BY dc.id
    `,
      [id],
    )

    const cotizacionData = {
      ...cotizacion,
      fecha_cotizacion: cotizacion.fecha_cotizacion.toISOString().split("T")[0],
      fecha_vencimiento: cotizacion.fecha_vencimiento ? cotizacion.fecha_vencimiento.toISOString().split("T")[0] : null,
      fecha_creacion: cotizacion.fecha_creacion.toISOString(),
      fecha_actualizacion: cotizacion.fecha_actualizacion.toISOString(),
      empresa_datos: empresaDatos,
      detalles: details.map((detail) => ({
        ...detail,
        fecha_creacion: detail.fecha_creacion.toISOString(),
      })),
    }

    res.status(200).json(cotizacionData)
  } catch (error) {
    console.error("Error al obtener cotización:", error)
    res.status(500).json({ message: "Error al obtener cotización" })
  }
}

// Obtener cotizaciones con filtros y paginación
export const getCotizaciones = async (req, res) => {
  try {
    console.log("getCotizaciones called with query:", req.query)

    const {
      fechaInicio = "",
      fechaFin = "",
      cliente = "",
      numeroCotizacion = "",
      estado = "todos",
      limit = 10,
      offset = 0,
    } = req.query

    let baseQuery = `
      FROM cotizaciones c
      JOIN clientes cl ON c.cliente_id = cl.id
      JOIN usuarios u ON c.usuario_id = u.id
      WHERE 1=1
    `

    const queryParams = []

    if (fechaInicio) {
      baseQuery += ` AND DATE(c.fecha_cotizacion) >= ?`
      queryParams.push(fechaInicio)
    }

    if (fechaFin) {
      baseQuery += ` AND DATE(c.fecha_cotizacion) <= ?`
      queryParams.push(fechaFin)
    }

    if (cliente) {
      baseQuery += ` AND cl.nombre LIKE ?`
      queryParams.push(`%${cliente}%`)
    }

    if (numeroCotizacion) {
      baseQuery += ` AND c.numero_cotizacion LIKE ?`
      queryParams.push(`%${numeroCotizacion}%`)
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
        c.numero_cotizacion,
        c.fecha_cotizacion,
        c.fecha_vencimiento,
        c.subtotal,
        c.descuento,
        c.interes,
        c.total,
        c.estado,
        c.observaciones,
        c.tiempo_entrega,
        c.validez_dias,
        c.fecha_creacion,
        cl.nombre as cliente_nombre,
        u.nombre as usuario_nombre
      ${baseQuery}
      ORDER BY c.fecha_cotizacion DESC, c.id DESC
      LIMIT ? OFFSET ?
    `
    const finalDataParams = [...queryParams, Number.parseInt(limit), Number.parseInt(offset)]
    const [cotizaciones] = await pool.query(dataQuery, finalDataParams)

    console.log("Found cotizaciones:", cotizaciones.length)

    const cotizacionesWithISODate = cotizaciones.map((cotizacion) => ({
      ...cotizacion,
      fecha_cotizacion: cotizacion.fecha_cotizacion.toISOString().split("T")[0],
      fecha_vencimiento: cotizacion.fecha_vencimiento ? cotizacion.fecha_vencimiento.toISOString().split("T")[0] : null,
      fecha_creacion: cotizacion.fecha_creacion.toISOString(),
    }))

    console.log("Returning cotizaciones data with pagination")
    res.status(200).json({
      success: true,
      data: cotizacionesWithISODate,
      pagination: {
        totalItems: total,
        totalPages: Math.ceil(total / limit),
        currentPage: Math.floor(offset / limit) + 1,
        itemsPerPage: Number.parseInt(limit),
      },
    })
  } catch (error) {
    console.error("Error al obtener cotizaciones:", error)
    res.status(500).json({
      success: false,
      message: "Error al obtener cotizaciones",
      error: error.message,
    })
  }
}

// Obtener estadísticas de cotizaciones
export const getCotizacionesStats = async (req, res) => {
  try {
    console.log("getCotizacionesStats called with query:", req.query)

    const { fechaInicio = "", fechaFin = "" } = req.query

    let whereClause = "WHERE 1=1"
    const queryParams = []

    if (fechaInicio) {
      whereClause += " AND DATE(c.fecha_cotizacion) >= ?"
      queryParams.push(fechaInicio)
    }

    if (fechaFin) {
      whereClause += " AND DATE(c.fecha_cotizacion) <= ?"
      queryParams.push(fechaFin)
    }

    // Estadísticas generales
    const [generalStats] = await pool.query(
      `
      SELECT 
        COUNT(*) as total_cotizaciones,
        SUM(c.total) as total_cotizado,
        AVG(c.total) as promedio_cotizacion,
        SUM(CASE WHEN c.estado = 'activa' THEN 1 ELSE 0 END) as cotizaciones_activas,
        SUM(CASE WHEN c.estado = 'aceptada' THEN 1 ELSE 0 END) as cotizaciones_aceptadas,
        SUM(CASE WHEN c.estado = 'rechazada' THEN 1 ELSE 0 END) as cotizaciones_rechazadas,
        SUM(CASE WHEN c.estado = 'vencida' THEN 1 ELSE 0 END) as cotizaciones_vencidas,
        SUM(CASE WHEN c.estado = 'anulada' THEN 1 ELSE 0 END) as cotizaciones_anuladas,
        SUM(CASE WHEN c.estado = 'aceptada' THEN c.total ELSE 0 END) as total_aceptado
      FROM cotizaciones c
      ${whereClause}
    `,
      queryParams,
    )

    // Cotizaciones por día
    const [cotizacionesByDay] = await pool.query(
      `
      SELECT 
        DATE(c.fecha_cotizacion) as fecha,
        COUNT(*) as cantidad_cotizaciones,
        SUM(c.total) as total_dia
      FROM cotizaciones c
      ${whereClause}
      GROUP BY DATE(c.fecha_cotizacion)
      ORDER BY fecha DESC
      LIMIT 30
    `,
      queryParams,
    )

    // Top clientes
    const [topClients] = await pool.query(
      `
      SELECT 
        cl.id,
        cl.nombre,
        COUNT(c.id) as cantidad_cotizaciones,
        SUM(c.total) as total_cotizado,
        SUM(CASE WHEN c.estado = 'aceptada' THEN c.total ELSE 0 END) as total_aceptado
      FROM cotizaciones c
      JOIN clientes cl ON c.cliente_id = cl.id
      ${whereClause}
      GROUP BY cl.id
      ORDER BY total_cotizado DESC
      LIMIT 10
    `,
      queryParams,
    )

    // Estados de cotizaciones
    const [estadosCotizaciones] = await pool.query(
      `
      SELECT 
        c.estado,
        COUNT(c.id) as cantidad,
        SUM(c.total) as total_monto
      FROM cotizaciones c
      ${whereClause}
      GROUP BY c.estado
      ORDER BY cantidad DESC
    `,
      queryParams,
    )

    const stats = {
      estadisticas_generales: generalStats[0],
      cotizaciones_por_dia: cotizacionesByDay.map((day) => ({
        ...day,
        fecha: day.fecha.toISOString().split("T")[0],
      })),
      top_clientes: topClients,
      estados_cotizaciones: estadosCotizaciones,
    }

    console.log("Returning cotizaciones stats:", stats)
    res.status(200).json(stats)
  } catch (error) {
    console.error("Error al obtener estadísticas de cotizaciones:", error)
    res.status(500).json({
      success: false,
      message: "Error al obtener estadísticas",
      error: error.message,
    })
  }
}

// Obtener cotizaciones por cliente
export const getCotizacionesByClient = async (req, res) => {
  try {
    const { clientId } = req.params
    const { limit = 10, offset = 0, estado = "todos" } = req.query

    const [client] = await pool.query("SELECT id, nombre FROM clientes WHERE id = ? AND activo = TRUE", [clientId])

    if (client.length === 0) {
      return res.status(404).json({ message: "Cliente no encontrado" })
    }

    let baseQuery = `
      FROM cotizaciones c
      JOIN usuarios u ON c.usuario_id = u.id
      WHERE c.cliente_id = ?
    `

    const queryParams = [clientId]

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
        c.numero_cotizacion,
        c.fecha_cotizacion,
        c.fecha_vencimiento,
        c.subtotal,
        c.descuento,
        c.interes,
        c.total,
        c.estado,
        c.observaciones,
        c.tiempo_entrega,
        c.fecha_creacion,
        u.nombre as usuario_nombre
      ${baseQuery}
      ORDER BY c.fecha_cotizacion DESC, c.id DESC
      LIMIT ? OFFSET ?
    `
    const finalDataParams = [...queryParams, Number.parseInt(limit), Number.parseInt(offset)]
    const [cotizaciones] = await pool.query(dataQuery, finalDataParams)

    const cotizacionesWithISODate = cotizaciones.map((cotizacion) => ({
      ...cotizacion,
      fecha_cotizacion: cotizacion.fecha_cotizacion.toISOString().split("T")[0],
      fecha_vencimiento: cotizacion.fecha_vencimiento ? cotizacion.fecha_vencimiento.toISOString().split("T")[0] : null,
      fecha_creacion: cotizacion.fecha_creacion.toISOString(),
    }))

    res.status(200).json({
      success: true,
      cliente: client[0],
      data: cotizacionesWithISODate,
      pagination: {
        totalItems: total,
        totalPages: Math.ceil(total / limit),
        currentPage: Math.floor(offset / limit) + 1,
        itemsPerPage: Number.parseInt(limit),
      },
    })
  } catch (error) {
    console.error("Error al obtener cotizaciones del cliente:", error)
    res.status(500).json({
      success: false,
      message: "Error al obtener cotizaciones del cliente",
    })
  }
}

// Actualizar cotización
export const updateCotizacion = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  try {
    const { id } = req.params
    const { observaciones, condicionesComerciales, tiempoEntrega, fechaVencimiento } = req.body

    const [result] = await pool.query(
      `UPDATE cotizaciones SET 
        observaciones = ?, 
        condiciones_comerciales = ?, 
        tiempo_entrega = ?, 
        fecha_vencimiento = ?
      WHERE id = ?`,
      [observaciones, condicionesComerciales, tiempoEntrega, fechaVencimiento, id],
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Cotización no encontrada" })
    }

    res.status(200).json({
      message: "Cotización actualizada exitosamente",
      data: {
        id,
        observaciones,
        condicionesComerciales,
        tiempoEntrega,
        fechaVencimiento,
      },
    })
  } catch (error) {
    console.error("Error al actualizar cotización:", error)
    res.status(500).json({ message: "Error al actualizar cotización" })
  }
}

// Actualizar estado de cotización
export const updateCotizacionStatus = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  try {
    const { id } = req.params
    const { estado, motivo = "" } = req.body

    const observacionesUpdate = motivo
      ? `CONCAT(COALESCE(observaciones, ''), ' - CAMBIO ESTADO: ${estado.toUpperCase()}: ', ?)`
      : "observaciones"

    const [result] = await pool.query(
      `UPDATE cotizaciones SET estado = ?, observaciones = ${observacionesUpdate} WHERE id = ?`,
      motivo ? [estado, motivo, id] : [estado, id],
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Cotización no encontrada" })
    }

    res.status(200).json({
      message: `Cotización marcada como ${estado} exitosamente`,
      data: { id, estado, motivo },
    })
  } catch (error) {
    console.error("Error al actualizar estado de cotización:", error)
    res.status(500).json({ message: "Error al actualizar estado de cotización" })
  }
}

// Anular cotización
export const cancelCotizacion = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  try {
    const { id } = req.params
    const { motivo } = req.body

    const [cotizaciones] = await pool.query("SELECT * FROM cotizaciones WHERE id = ? AND estado != 'anulada'", [id])

    if (cotizaciones.length === 0) {
      return res.status(404).json({ message: "Cotización no encontrada o ya está anulada" })
    }

    const cotizacion = cotizaciones[0]

    await pool.query(
      `UPDATE cotizaciones SET 
        estado = 'anulada', 
        observaciones = CONCAT(COALESCE(observaciones, ''), ' - ANULADA: ', ?) 
      WHERE id = ?`,
      [motivo, id],
    )

    res.status(200).json({
      message: "Cotización anulada exitosamente",
      data: {
        id,
        numeroCotizacion: cotizacion.numero_cotizacion,
        motivo,
      },
    })
  } catch (error) {
    console.error("Error al anular cotización:", error)
    res.status(500).json({ message: error.message || "Error al anular cotización" })
  }
}

// Convertir cotización a presupuesto
export const convertCotizacionToPresupuesto = async (req, res) => {
  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const { id } = req.params

    // Obtener cotización
    const [cotizaciones] = await connection.query("SELECT * FROM cotizaciones WHERE id = ? AND estado = 'aceptada'", [
      id,
    ])

    if (cotizaciones.length === 0) {
      await connection.rollback()
      return res.status(404).json({
        message: "Cotización no encontrada o no está en estado 'aceptada'",
      })
    }

    const cotizacion = cotizaciones[0]

    // Obtener detalles de la cotización
    const [detalles] = await connection.query("SELECT * FROM detalles_cotizaciones WHERE cotizacion_id = ?", [id])

    // Generar número de presupuesto
    const [configPresupuesto] = await connection.query(`
      SELECT clave, valor FROM configuracion 
      WHERE clave IN ('presupuesto_numero_siguiente', 'presupuesto_prefijo')
      FOR UPDATE
    `)

    const configObj = {}
    configPresupuesto.forEach((item) => {
      configObj[item.clave] = item.valor
    })

    const nextNumber = Number.parseInt(configObj.presupuesto_numero_siguiente)
    const prefix = configObj.presupuesto_prefijo || "PRES-"
    const numeroPresupuesto = `${prefix}${nextNumber.toString().padStart(6, "0")}`

    // Crear presupuesto
    const [presupuestoResult] = await connection.query(
      `INSERT INTO presupuestos (
        numero_presupuesto, cliente_id, usuario_id, fecha_presupuesto,
        subtotal, descuento, interes, total, observaciones,
        empresa_datos, estado
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'activo')`,
      [
        numeroPresupuesto,
        cotizacion.cliente_id,
        req.user.id,
        new Date().toISOString().split("T")[0],
        cotizacion.subtotal,
        cotizacion.descuento,
        cotizacion.interes,
        cotizacion.total,
        `Generado desde cotización ${cotizacion.numero_cotizacion}. ${cotizacion.observaciones || ""}`,
        cotizacion.empresa_datos,
      ],
    )

    const presupuestoId = presupuestoResult.insertId

    // Crear detalles del presupuesto
    for (const detalle of detalles) {
      await connection.query(
        `INSERT INTO detalles_presupuestos (
          presupuesto_id, producto_id, cantidad, precio_unitario, 
          subtotal, discount_percentage
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          presupuestoId,
          detalle.producto_id,
          detalle.cantidad,
          detalle.precio_unitario,
          detalle.subtotal,
          detalle.discount_percentage,
        ],
      )
    }

    // Actualizar contador de presupuestos
    await connection.query("UPDATE configuracion SET valor = ? WHERE clave = 'presupuesto_numero_siguiente'", [
      (nextNumber + 1).toString(),
    ])

    // Marcar cotización como convertida (opcional, puedes mantener como aceptada)
    await connection.query(
      `UPDATE cotizaciones SET 
        observaciones = CONCAT(COALESCE(observaciones, ''), ' - CONVERTIDA A PRESUPUESTO: ', ?)
      WHERE id = ?`,
      [numeroPresupuesto, id],
    )

    await connection.commit()

    res.status(201).json({
      message: "Cotización convertida a presupuesto exitosamente",
      data: {
        cotizacionId: id,
        presupuestoId: presupuestoId,
        numeroPresupuesto: numeroPresupuesto,
        numeroCotizacion: cotizacion.numero_cotizacion,
      },
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al convertir cotización a presupuesto:", error)
    res.status(500).json({
      message: error.message || "Error al convertir cotización a presupuesto",
    })
  } finally {
    connection.release()
  }
}
