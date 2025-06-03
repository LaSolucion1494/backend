// clients.controller.js
import pool from "../db.js"
import { validationResult } from "express-validator"

// Obtener todos los clientes con filtros
export const getClients = async (req, res) => {
  try {
    const { search = "", activo = "true", limit = 50, offset = 0 } = req.query

    let query = `
      SELECT 
        id,
        nombre,
        telefono,
        email,
        direccion,
        cuit,
        notas,
        activo,
        fecha_creacion,
        fecha_actualizacion
      FROM clientes
      WHERE 1=1
    `

    const queryParams = []

    // Filtro de búsqueda
    if (search) {
      query += ` AND (
        nombre LIKE ? OR 
        telefono LIKE ? OR 
        email LIKE ? OR
        cuit LIKE ?
      )`
      const searchTerm = `%${search}%`
      queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm)
    }

    // Filtro por estado activo
    if (activo !== "todos") {
      query += ` AND activo = ?`
      queryParams.push(activo === "true")
    }

    // Ordenar y paginar
    query += ` ORDER BY nombre ASC LIMIT ? OFFSET ?`
    queryParams.push(Number.parseInt(limit), Number.parseInt(offset))

    const [clients] = await pool.query(query, queryParams)

    // Convertir fechas a ISO
    const clientsWithISODate = clients.map(client => ({
      ...client,
      fecha_creacion: client.fecha_creacion.toISOString(),
      fecha_actualizacion: client.fecha_actualizacion.toISOString()
    }))

    res.status(200).json(clientsWithISODate)
  } catch (error) {
    console.error("Error al obtener clientes:", error)
    res.status(500).json({ message: "Error al obtener clientes" })
  }
}

// Obtener un cliente por ID
export const getClientById = async (req, res) => {
  try {
    const { id } = req.params

    const [clients] = await pool.query(
      "SELECT * FROM clientes WHERE id = ?",
      [id]
    )

    if (clients.length === 0) {
      return res.status(404).json({ message: "Cliente no encontrado" })
    }

    const client = {
      ...clients[0],
      fecha_creacion: clients[0].fecha_creacion.toISOString(),
      fecha_actualizacion: clients[0].fecha_actualizacion.toISOString()
    }

    res.status(200).json(client)
  } catch (error) {
    console.error("Error al obtener cliente:", error)
    res.status(500).json({ message: "Error al obtener cliente" })
  }
}

// Crear un nuevo cliente
export const createClient = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  try {
    const {
      nombre,
      telefono = null,
      email = null,
      direccion = null,
      cuit = null,
      notas = null
    } = req.body

    // Verificar si ya existe un cliente con el mismo nombre
    const [existingClient] = await pool.query(
      "SELECT id FROM clientes WHERE nombre = ? AND id != 1", // Excluir cliente por defecto
      [nombre]
    )

    if (existingClient.length > 0) {
      return res.status(400).json({ message: "Ya existe un cliente con ese nombre" })
    }

    // Insertar cliente
    const [result] = await pool.query(
      `
      INSERT INTO clientes (
        nombre, telefono, email, direccion, cuit, notas
      ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [nombre, telefono, email, direccion, cuit, notas]
    )

    res.status(201).json({
      message: "Cliente creado exitosamente",
      id: result.insertId
    })
  } catch (error) {
    console.error("Error al crear cliente:", error)
    res.status(500).json({ message: "Error al crear cliente" })
  }
}

// Actualizar un cliente
export const updateClient = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  try {
    const { id } = req.params
    const {
      nombre,
      telefono = null,
      email = null,
      direccion = null,
      cuit = null,
      notas = null
    } = req.body

    // Verificar que no sea el cliente por defecto (id=1)
    if (Number(id) === 1) {
      return res.status(400).json({ message: "No se puede modificar el cliente por defecto" })
    }

    // Verificar si el cliente existe
    const [existingClient] = await pool.query(
      "SELECT id FROM clientes WHERE id = ?",
      [id]
    )

    if (existingClient.length === 0) {
      return res.status(404).json({ message: "Cliente no encontrado" })
    }

    // Verificar si ya existe otro cliente con el mismo nombre
    const [duplicateClient] = await pool.query(
      "SELECT id FROM clientes WHERE nombre = ? AND id != ? AND id != 1",
      [nombre, id]
    )

    if (duplicateClient.length > 0) {
      return res.status(400).json({ message: "Ya existe otro cliente con ese nombre" })
    }

    // Actualizar cliente
    await pool.query(
      `
      UPDATE clientes SET
        nombre = ?,
        telefono = ?,
        email = ?,
        direccion = ?,
        cuit = ?,
        notas = ?
      WHERE id = ?
      `,
      [nombre, telefono, email, direccion, cuit, notas, id]
    )

    res.status(200).json({ message: "Cliente actualizado exitosamente" })
  } catch (error) {
    console.error("Error al actualizar cliente:", error)
    res.status(500).json({ message: "Error al actualizar cliente" })
  }
}

// Cambiar estado de un cliente (activar/desactivar)
export const toggleClientStatus = async (req, res) => {
  try {
    const { id } = req.params
    const { activo } = req.body

    // Verificar que no sea el cliente por defecto (id=1)
    if (Number(id) === 1) {
      return res.status(400).json({ message: "No se puede desactivar el cliente por defecto" })
    }

    // Verificar si el cliente existe
    const [existingClient] = await pool.query(
      "SELECT id FROM clientes WHERE id = ?",
      [id]
    )

    if (existingClient.length === 0) {
      return res.status(404).json({ message: "Cliente no encontrado" })
    }

    // Actualizar estado
    await pool.query(
      "UPDATE clientes SET activo = ? WHERE id = ?",
      [activo, id]
    )

    res.status(200).json({
      message: activo ? "Cliente activado exitosamente" : "Cliente desactivado exitosamente"
    })
  } catch (error) {
    console.error("Error al cambiar estado del cliente:", error)
    res.status(500).json({ message: "Error al cambiar estado del cliente" })
  }
}

// Eliminar un cliente (eliminación permanente)
export const deleteClient = async (req, res) => {
  try {
    const { id } = req.params

    // Verificar que no sea el cliente por defecto (id=1)
    if (Number(id) === 1) {
      return res.status(400).json({ message: "No se puede eliminar el cliente por defecto" })
    }

    // Verificar si el cliente existe
    const [existingClient] = await pool.query(
      "SELECT id FROM clientes WHERE id = ?",
      [id]
    )

    if (existingClient.length === 0) {
      return res.status(404).json({ message: "Cliente no encontrado" })
    }

    // Verificar si el cliente tiene ventas asociadas
    const [clientSales] = await pool.query(
      "SELECT id FROM ventas WHERE cliente_id = ? LIMIT 1",
      [id]
    )

    if (clientSales.length > 0) {
      return res.status(400).json({
        message: "No se puede eliminar el cliente porque tiene ventas asociadas"
      })
    }

    // Eliminar cliente
    await pool.query("DELETE FROM clientes WHERE id = ?", [id])

    res.status(200).json({ message: "Cliente eliminado exitosamente" })
  } catch (error) {
    console.error("Error al eliminar cliente:", error)
    res.status(500).json({ message: "Error al eliminar cliente" })
  }
}

// Buscar cliente por nombre o teléfono (para autocompletado)
export const searchClients = async (req, res) => {
  try {
    const { term } = req.query

    if (!term || term.length < 2) {
      return res.status(200).json([])
    }

    const [clients] = await pool.query(
      `
      SELECT id, nombre, telefono, email, cuit
      FROM clientes
      WHERE (nombre LIKE ? OR telefono LIKE ? OR email LIKE ? OR cuit LIKE ?)
      AND activo = TRUE
      ORDER BY nombre ASC
      LIMIT 10
      `,
      [`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`]
    )

    res.status(200).json(clients)
  } catch (error) {
    console.error("Error al buscar clientes:", error)
    res.status(500).json({ message: "Error al buscar clientes" })
  }
}