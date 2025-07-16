// presupuestos.controller.js
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

// Crear un nuevo presupuesto
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
      validezDias = 30,
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
        c.nombre
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

    // Generar número de presupuesto
    const numeroPresupuesto = await generatePresupuestoNumber(connection)

    if (!numeroPresupuesto) {
      await connection.rollback()
      return res.status(500).json({ message: "Error al generar número de presupuesto" })
    }

    // Procesar productos (sin afectar stock)
    for (const item of productos) {
      const [producto] = await connection.query(
        "SELECT id, nombre, precio_venta FROM productos WHERE id = ? AND activo = TRUE",
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

    // Calcular fecha de vencimiento
    const fechaVencimiento = new Date(fechaPresupuesto)
    fechaVencimiento.setDate(fechaVencimiento.getDate() + Number.parseInt(validezDias))

    const [presupuestoResult] = await connection.query(
      `
      INSERT INTO presupuestos (
        numero_presupuesto, cliente_id, usuario_id, fecha_presupuesto,
        subtotal, descuento, interes, total, observaciones,
        fecha_vencimiento, empresa_datos, estado
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'activo')
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
        fechaVencimiento.toISOString().split("T")[0],
        JSON.stringify(empresaDatos),
      ],
    )

    const presupuestoId = presupuestoResult.insertId

    // Insertar detalles del presupuesto
    for (const item of productsToProcess) {
      const discountPercentage = Number.parseFloat(item.discount_percentage || 0)

      await connection.query(
        "INSERT INTO detalles_presupuestos (presupuesto_id, producto_id, cantidad, precio_unitario, subtotal, discount_percentage) VALUES (?, ?, ?, ?, ?, ?)",
        [presupuestoId, item.productoId, item.cantidad, item.precioUnitario, item.subtotalItem, discountPercentage],
      )
    }

    // Insertar métodos de pago (solo para referencia)
    for (const pago of pagos) {
      await connection.query(
        "INSERT INTO presupuesto_pagos (presupuesto_id, tipo_pago, monto, descripcion) VALUES (?, ?, ?, ?)",
        [presupuestoId, pago.tipo, Number.parseFloat(pago.monto), pago.descripcion || ""],
      )
    }

    await connection.commit()

    res.status(201).json({
      message: "Presupuesto creado exitosamente",
      data: {
        id: presupuestoId,
        numeroPresupuesto: numeroPresupuesto,
        total,
        fechaVencimiento: fechaVencimiento.toISOString().split("T")[0],
        empresaDatos,
        estado: "activo",
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
        p.marca as producto_marca
      FROM detalles_presupuestos dp
      JOIN productos p ON dp.producto_id = p.id
      WHERE dp.presupuesto_id = ?
      ORDER BY dp.id
    `,
      [id],
    )

    const [payments] = await pool.query(
      `
      SELECT * FROM presupuesto_pagos
      WHERE presupuesto_id = ? 
      ORDER BY id
    `,
      [id],
    )

    const presupuestoData = {
      ...presupuesto,
      fecha_presupuesto: presupuesto.fecha_presupuesto.toISOString().split("T")[0],
      fecha_vencimiento: presupuesto.fecha_vencimiento
        ? presupuesto.fecha_vencimiento.toISOString().split("T")[0]
        : null,
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
        p.fecha_vencimiento,
        p.subtotal,
        p.descuento,
        p.interes,
        p.total,
        p.estado,
        p.observaciones,
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
      fecha_vencimiento: presupuesto.fecha_vencimiento
        ? presupuesto.fecha_vencimiento.toISOString().split("T")[0]
        : null,
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

// Cambiar estado de presupuesto
export const updatePresupuestoEstado = async (req, res) => {
  try {
    const { id } = req.params
    const { estado, observaciones = "" } = req.body

    const validStates = ["activo", "convertido", "vencido", "cancelado"]
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
