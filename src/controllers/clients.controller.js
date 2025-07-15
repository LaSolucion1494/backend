// clients.controller.js - ACTUALIZADO CON PAGINACIÓN COMPLETA
import pool from "../db.js"
import { validationResult } from "express-validator"

// Obtener todos los clientes con filtros y paginación
export const getClients = async (req, res) => {
  try {
    const { search = "", activo = "todos", conCuentaCorriente = "todos", limit = 10, offset = 0 } = req.query

    let baseQuery = `FROM clientes c WHERE 1=1`
    const queryParams = []

    // Filtro de búsqueda
    if (search) {
      baseQuery += ` AND (c.nombre LIKE ? OR c.telefono LIKE ? OR c.email LIKE ? OR c.cuit LIKE ?)`
      const searchTerm = `%${search}%`
      queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm)
    }

    // Filtro por estado activo
    if (activo !== "todos") {
      baseQuery += ` AND c.activo = ?`
      queryParams.push(activo === "true")
    }

    // Filtro por cuenta corriente
    if (conCuentaCorriente === "true") {
      baseQuery += ` AND c.tiene_cuenta_corriente = TRUE`
    } else if (conCuentaCorriente === "false") {
      baseQuery += ` AND c.tiene_cuenta_corriente = FALSE`
    }

    // --- NUEVO: Query para contar el total de resultados ---
    const countQuery = `SELECT COUNT(*) as total ${baseQuery}`
    const [[{ total }]] = await pool.query(countQuery, queryParams)

    // --- Query para obtener los datos paginados ---
    const dataQuery = `
      SELECT 
        c.id, c.nombre, c.telefono, c.email, c.direccion, c.cuit, c.notas, c.activo,
        c.tiene_cuenta_corriente, c.limite_credito, c.saldo_cuenta_corriente,
        c.fecha_creacion, c.fecha_actualizacion,
        CASE 
          WHEN c.limite_credito IS NULL THEN 999999999
          ELSE GREATEST(0, c.limite_credito - c.saldo_cuenta_corriente)
        END as saldo_disponible
      ${baseQuery}
      ORDER BY c.nombre ASC
      LIMIT ? OFFSET ?
    `
    const finalDataParams = [...queryParams, Number.parseInt(limit), Number.parseInt(offset)]
    const [clients] = await pool.query(dataQuery, finalDataParams)

    const clientsWithISODate = clients.map((client) => ({
      ...client,
      saldo_cuenta_corriente: client.saldo_cuenta_corriente || 0,
      saldo_disponible: client.saldo_disponible || 0,
      fecha_creacion: client.fecha_creacion.toISOString(),
      fecha_actualizacion: client.fecha_actualizacion.toISOString(),
    }))

    // --- NUEVO: Estructura de respuesta con datos y paginación ---
    res.status(200).json({
      data: clientsWithISODate,
      pagination: {
        totalItems: total,
        totalPages: Math.ceil(total / limit),
        currentPage: Math.floor(offset / limit) + 1,
        itemsPerPage: Number.parseInt(limit),
      },
    })
  } catch (error) {
    console.error("Error al obtener clientes:", error)
    res.status(500).json({ message: "Error al obtener clientes" })
  }
}

// Obtener un cliente por ID (CORREGIDO para mostrar saldos)
export const getClientById = async (req, res) => {
  try {
    const { id } = req.params

    const [clients] = await pool.query(
      `
      SELECT 
        c.*,
        CASE 
          WHEN c.limite_credito IS NULL THEN 999999999
          ELSE GREATEST(0, c.limite_credito - c.saldo_cuenta_corriente)
        END as saldo_disponible
      FROM clientes c
      WHERE c.id = ?
    `,
      [id],
    )

    if (clients.length === 0) {
      return res.status(404).json({ message: "Cliente no encontrado" })
    }

    const clientData = clients[0]

    const client = {
      id: clientData.id,
      nombre: clientData.nombre,
      telefono: clientData.telefono,
      email: clientData.email,
      direccion: clientData.direccion,
      cuit: clientData.cuit,
      notas: clientData.notas,
      activo: clientData.activo,
      tiene_cuenta_corriente: clientData.tiene_cuenta_corriente,
      limite_credito: clientData.limite_credito,
      saldo_cuenta_corriente: clientData.saldo_cuenta_corriente || 0,
      saldo_disponible: clientData.saldo_disponible || 0,
      fecha_creacion: clientData.fecha_creacion.toISOString(),
      fecha_actualizacion: clientData.fecha_actualizacion.toISOString(),
    }

    if (client.tiene_cuenta_corriente) {
      client.cuenta_corriente = {
        limite_credito: clientData.limite_credito,
        saldo_actual: clientData.saldo_cuenta_corriente,
        saldo_disponible: clientData.saldo_disponible,
      }
    }

    res.status(200).json(client)
  } catch (error) {
    console.error("Error al obtener cliente:", error)
    res.status(500).json({ message: "Error al obtener cliente" })
  }
}

// Crear un nuevo cliente (No requiere cambios)
export const createClient = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const {
      nombre,
      telefono = null,
      email = null,
      direccion = null,
      cuit = null,
      notas = null,
      tieneCuentaCorriente = false,
      limiteCredito = null,
    } = req.body

    const [existingClient] = await connection.query("SELECT id FROM clientes WHERE nombre = ? AND id != 1", [nombre])

    if (existingClient.length > 0) {
      await connection.rollback()
      return res.status(400).json({ message: "Ya existe un cliente con ese nombre" })
    }

    if (tieneCuentaCorriente && limiteCredito !== null && limiteCredito < 0) {
      await connection.rollback()
      return res.status(400).json({ message: "El límite de crédito no puede ser negativo" })
    }

    const [result] = await connection.query(
      `
      INSERT INTO clientes (
        nombre, telefono, email, direccion, cuit, notas, 
        tiene_cuenta_corriente, limite_credito, saldo_cuenta_corriente
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0.00)
      `,
      [
        nombre,
        telefono,
        email,
        direccion,
        cuit,
        notas,
        tieneCuentaCorriente,
        tieneCuentaCorriente ? limiteCredito : null,
      ],
    )

    const clienteId = result.insertId

    await connection.commit()

    res.status(201).json({
      message: "Cliente creado exitosamente",
      id: clienteId,
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al crear cliente:", error)
    res.status(500).json({ message: "Error al crear cliente" })
  } finally {
    connection.release()
  }
}

// Actualizar un cliente (No requiere cambios)
export const updateClient = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const { id } = req.params
    const {
      nombre,
      telefono = null,
      email = null,
      direccion = null,
      cuit = null,
      notas = null,
      tieneCuentaCorriente = false,
      limiteCredito = null,
    } = req.body

    if (Number(id) === 1) {
      await connection.rollback()
      return res.status(400).json({ message: "No se puede modificar el cliente por defecto" })
    }

    const [existingClient] = await connection.query(
      "SELECT tiene_cuenta_corriente, saldo_cuenta_corriente FROM clientes WHERE id = ?",
      [id],
    )

    if (existingClient.length === 0) {
      await connection.rollback()
      return res.status(404).json({ message: "Cliente no encontrado" })
    }

    const [duplicateClient] = await connection.query(
      "SELECT id FROM clientes WHERE nombre = ? AND id != ? AND id != 1",
      [nombre, id],
    )

    if (duplicateClient.length > 0) {
      await connection.rollback()
      return res.status(400).json({ message: "Ya existe otro cliente con ese nombre" })
    }

    const teniaCC = existingClient[0].tiene_cuenta_corriente

    if (tieneCuentaCorriente && limiteCredito !== null && limiteCredito < 0) {
      await connection.rollback()
      return res.status(400).json({ message: "El límite de crédito no puede ser negativo" })
    }

    if (teniaCC && !tieneCuentaCorriente && Math.abs(existingClient[0].saldo_cuenta_corriente) > 0.01) {
      await connection.rollback()
      return res.status(400).json({
        message: `No se puede desactivar la cuenta corriente porque tiene saldo pendiente: $${existingClient[0].saldo_cuenta_corriente.toFixed(2)}`,
      })
    }

    await connection.query(
      `
      UPDATE clientes SET
        nombre = ?, telefono = ?, email = ?, direccion = ?, cuit = ?, notas = ?,
        tiene_cuenta_corriente = ?, limite_credito = ?
      WHERE id = ?
      `,
      [
        nombre,
        telefono,
        email,
        direccion,
        cuit,
        notas,
        tieneCuentaCorriente,
        tieneCuentaCorriente ? limiteCredito : null,
        id,
      ],
    )

    await connection.commit()

    res.status(200).json({ message: "Cliente actualizado exitosamente" })
  } catch (error) {
    await connection.rollback()
    console.error("Error al actualizar cliente:", error)
    res.status(500).json({ message: "Error al actualizar cliente" })
  } finally {
    connection.release()
  }
}

// Cambiar estado de un cliente (activar/desactivar) (No requiere cambios)
export const toggleClientStatus = async (req, res) => {
  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const { id } = req.params
    const { activo } = req.body

    if (Number(id) === 1) {
      await connection.rollback()
      return res.status(400).json({ message: "No se puede desactivar el cliente por defecto" })
    }

    const [existingClient] = await connection.query(
      `SELECT id, tiene_cuenta_corriente, saldo_cuenta_corriente FROM clientes WHERE id = ?`,
      [id],
    )

    if (existingClient.length === 0) {
      await connection.rollback()
      return res.status(404).json({ message: "Cliente no encontrado" })
    }

    const cliente = existingClient[0]

    if (!activo && cliente.tiene_cuenta_corriente && Math.abs(cliente.saldo_cuenta_corriente) > 0.01) {
      await connection.rollback()
      return res.status(400).json({
        message: `No se puede desactivar el cliente porque tiene saldo pendiente en cuenta corriente: $${cliente.saldo_cuenta_corriente.toFixed(2)}`,
      })
    }

    await connection.query("UPDATE clientes SET activo = ? WHERE id = ?", [activo, id])

    await connection.commit()

    res.status(200).json({
      message: activo ? "Cliente activado exitosamente" : "Cliente desactivado exitosamente",
    })
  } catch (error) {
    await connection.rollback()
    console.error("Error al cambiar estado del cliente:", error)
    res.status(500).json({ message: "Error al cambiar estado del cliente" })
  } finally {
    connection.release()
  }
}

// Eliminar un cliente (eliminación permanente) (No requiere cambios)
export const deleteClient = async (req, res) => {
  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const { id } = req.params

    if (Number(id) === 1) {
      await connection.rollback()
      return res.status(400).json({ message: "No se puede eliminar el cliente por defecto" })
    }

    const [existingClient] = await connection.query(
      `SELECT tiene_cuenta_corriente, saldo_cuenta_corriente FROM clientes WHERE id = ?`,
      [id],
    )

    if (existingClient.length === 0) {
      await connection.rollback()
      return res.status(404).json({ message: "Cliente no encontrado" })
    }

    const cliente = existingClient[0]

    const [clientSales] = await connection.query("SELECT id FROM ventas WHERE cliente_id = ? LIMIT 1", [id])

    if (clientSales.length > 0) {
      await connection.rollback()
      return res.status(400).json({
        message: "No se puede eliminar el cliente porque tiene ventas asociadas",
      })
    }

    if (cliente.tiene_cuenta_corriente && Math.abs(cliente.saldo_cuenta_corriente) > 0.01) {
      await connection.rollback()
      return res.status(400).json({
        message: `No se puede eliminar el cliente porque tiene saldo pendiente en cuenta corriente: $${cliente.saldo_cuenta_corriente.toFixed(2)}`,
      })
    }

    await connection.query("DELETE FROM movimientos_cuenta_corriente WHERE cliente_id = ?", [id])
    await connection.query("DELETE FROM pagos_cuenta_corriente WHERE cliente_id = ?", [id])
    await connection.query("DELETE FROM clientes WHERE id = ?", [id])

    await connection.commit()

    res.status(200).json({ message: "Cliente eliminado exitosamente" })
  } catch (error) {
    await connection.rollback()
    console.error("Error al eliminar cliente:", error)
    res.status(500).json({ message: "Error al eliminar cliente" })
  } finally {
    connection.release()
  }
}

// Buscar cliente por nombre o teléfono (para autocompletado) (CORREGIDO para mostrar saldos)
export const searchClients = async (req, res) => {
  try {
    const { term } = req.query

    if (!term || term.length < 2) {
      return res.status(200).json([])
    }

    const [clients] = await pool.query(
      `
      SELECT 
        c.id, c.nombre, c.telefono, c.email, c.cuit, c.direccion, c.tiene_cuenta_corriente,
        c.limite_credito, c.saldo_cuenta_corriente,
        CASE 
          WHEN c.limite_credito IS NULL THEN 999999999
          ELSE GREATEST(0, c.limite_credito - c.saldo_cuenta_corriente)
        END as saldo_disponible
      FROM clientes c
      WHERE (c.nombre LIKE ? OR c.telefono LIKE ? OR c.email LIKE ? OR c.cuit LIKE ?)
      AND c.activo = TRUE
      ORDER BY c.nombre ASC
      LIMIT 50
      `,
      [`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`],
    )

    const clientsData = clients.map((client) => ({
      ...client,
      saldo_cuenta_corriente: client.saldo_cuenta_corriente || 0,
      saldo_disponible: client.saldo_disponible || 0,
    }))

    res.status(200).json(clientsData)
  } catch (error) {
    console.error("Error al buscar clientes:", error)
    res.status(500).json({ message: "Error al buscar clientes" })
  }
}


// FUNCIONES PARA CUENTA CORRIENTE ACTUALIZADAS

// Obtener estado de cuenta corriente de un cliente (CORREGIDO para mostrar saldos)
export const getCuentaCorrienteByClient = async (req, res) => {
  try {
    const { clientId } = req.params
    const { limit = 50, offset = 0 } = req.query

    const [client] = await pool.query(
      "SELECT id, nombre, tiene_cuenta_corriente, limite_credito, saldo_cuenta_corriente FROM clientes WHERE id = ? AND activo = TRUE",
      [clientId],
    )

    if (client.length === 0) {
      return res.status(404).json({ message: "Cliente no encontrado" })
    }

    if (!client[0].tiene_cuenta_corriente) {
      return res.status(400).json({ message: "El cliente no tiene cuenta corriente habilitada" })
    }

    const saldoDisponible = client[0].limite_credito
      ? Math.max(0, client[0].limite_credito - client[0].saldo_cuenta_corriente)
      : 999999999

    const [movimientos] = await pool.query(
      `
      SELECT 
        m.id, m.tipo, m.concepto, m.monto, m.saldo_anterior, m.saldo_nuevo,
        m.referencia_id, m.referencia_tipo, m.numero_referencia, m.descripcion,
        m.fecha_movimiento, u.nombre as usuario_nombre
      FROM movimientos_cuenta_corriente m
      JOIN usuarios u ON m.usuario_id = u.id
      WHERE m.cliente_id = ?
      ORDER BY m.fecha_movimiento DESC, m.id DESC
      LIMIT ? OFFSET ?
    `,
      [clientId, Number.parseInt(limit), Number.parseInt(offset)],
    )

    const movimientosConFecha = movimientos.map((mov) => ({
      ...mov,
      fecha_movimiento: mov.fecha_movimiento.toISOString(),
    }))

    const response = {
      cliente: {
        ...client[0],
        saldo_cuenta_corriente: client[0].saldo_cuenta_corriente || 0,
      },
      cuenta: {
        limite_credito: client[0].limite_credito,
        saldo_actual: client[0].saldo_cuenta_corriente || 0,
        saldo_disponible: saldoDisponible,
      },
      movimientos: movimientosConFecha,
    }

    res.status(200).json(response)
  } catch (error) {
    console.error("Error al obtener cuenta corriente:", error)
    res.status(500).json({ message: "Error al obtener cuenta corriente" })
  }
}

// Obtener resumen de cuentas corrientes (CORREGIDO para mostrar saldos)
export const getResumenCuentasCorrientes = async (req, res) => {
  try {
    const { conSaldo = "todos" } = req.query

    let whereClause = "WHERE c.activo = TRUE AND c.tiene_cuenta_corriente = TRUE"
    const queryParams = []

    if (conSaldo === "true") {
      whereClause += " AND c.saldo_cuenta_corriente > 0.01"
    } else if (conSaldo === "false") {
      whereClause += " AND c.saldo_cuenta_corriente <= 0.01"
    }

    const [cuentas] = await pool.query(
      `
      SELECT 
        c.id, c.nombre, c.telefono, c.email, c.limite_credito,
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

    const [pagosMes] = await pool.query(`
      SELECT 
        COUNT(*) as total_pagos,
        COALESCE(SUM(monto), 0) as monto_total_pagos
      FROM pagos_cuenta_corriente
      WHERE MONTH(fecha_pago) = MONTH(CURRENT_DATE())
      AND YEAR(fecha_pago) = YEAR(CURRENT_DATE())
      AND estado = 'activo'
    `)

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

    const cuentasConFecha = cuentas.map((cuenta) => ({
      ...cuenta,
      saldo_cuenta_corriente: cuenta.saldo_actual || 0,
      fecha_actualizacion: cuenta.fecha_actualizacion.toISOString(),
      ultima_actividad: cuenta.ultima_actividad ? cuenta.ultima_actividad.toISOString() : null,
    }))

    const response = {
      cuentas: cuentasConFecha,
      resumen: {
        ...totales[0],
        pagos_mes_actual: pagosMes[0],
        ventas_mes_actual: ventasMes[0],
      },
    }

    res.status(200).json(response)
  } catch (error) {
    console.error("Error al obtener resumen de cuentas corrientes:", error)
    res.status(500).json({ message: "Error al obtener resumen de cuentas corrientes" })
  }
}
