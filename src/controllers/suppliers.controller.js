import pool from "../db.js"
import { validationResult } from "express-validator"

// Función para asegurar que existe el proveedor por defecto
const ensureDefaultSupplier = async () => {
  try {
    const [existing] = await pool.query("SELECT id FROM proveedores WHERE id = 1")
    if (existing.length === 0) {
      await pool.query(`
        INSERT INTO proveedores (id, cuit, nombre, telefono, direccion, activo) 
        VALUES (1, NULL, 'Sin Proveedor', NULL, NULL, TRUE)
      `)
      await pool.query("ALTER TABLE proveedores AUTO_INCREMENT = 2")
    } else {
      await pool.query(`
        UPDATE proveedores 
        SET nombre = 'Sin Proveedor', activo = TRUE 
        WHERE id = 1
      `)
    }
  } catch (error) {
    console.error("Error al asegurar proveedor por defecto:", error)
  }
}

// Obtener todos los proveedores con filtros y paginación
export const getSuppliers = async (req, res) => {
  try {
    await ensureDefaultSupplier()

    const { search = "", limit = 10, offset = 0 } = req.query

    let baseQuery = `FROM proveedores WHERE activo = TRUE`
    const queryParams = []

    if (search) {
      baseQuery += ` AND (nombre LIKE ? OR cuit LIKE ? OR telefono LIKE ? OR direccion LIKE ?)`
      const searchTerm = `%${search}%`
      queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm)
    }

    const countQuery = `SELECT COUNT(*) as total ${baseQuery}`
    const [[{ total }]] = await pool.query(countQuery, queryParams)

    const dataQuery = `
      SELECT id, cuit, nombre, telefono, direccion 
      ${baseQuery}
      ORDER BY CASE WHEN id = 1 THEN 0 ELSE 1 END, nombre ASC
      LIMIT ? OFFSET ?
    `
    const finalDataParams = [...queryParams, Number.parseInt(limit), Number.parseInt(offset)]
    const [suppliers] = await pool.query(dataQuery, finalDataParams)

    res.status(200).json({
      data: suppliers,
      pagination: {
        totalItems: total,
        totalPages: Math.ceil(total / limit),
        currentPage: Math.floor(offset / limit) + 1,
        itemsPerPage: Number.parseInt(limit),
      },
    })
  } catch (error) {
    console.error("Error al obtener proveedores:", error)
    res.status(500).json({ message: "Error al obtener proveedores" })
  }
}

// Crear un nuevo proveedor
export const createSupplier = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  try {
    const { cuit = "", nombre, telefono = "", direccion = "" } = req.body

    if (nombre.toLowerCase().trim() === "sin proveedor") {
      return res.status(400).json({ message: "El nombre 'Sin Proveedor' está reservado." })
    }

    const [existing] = await pool.query("SELECT id FROM proveedores WHERE nombre = ?", [nombre])
    if (existing.length > 0) {
      return res.status(400).json({ message: "El proveedor ya existe." })
    }

    if (cuit.trim()) {
      const [existingCuit] = await pool.query("SELECT id FROM proveedores WHERE cuit = ?", [cuit])
      if (existingCuit.length > 0) {
        return res.status(400).json({ message: "El CUIT ya existe." })
      }
    }

    const [result] = await pool.query(
      `INSERT INTO proveedores (cuit, nombre, telefono, direccion) VALUES (?, ?, ?, ?)`,
      [cuit, nombre, telefono, direccion],
    )

    res.status(201).json({
      message: "Proveedor creado exitosamente",
      id: result.insertId,
    })
  } catch (error) {
    console.error("Error al crear proveedor:", error)
    res.status(500).json({ message: "Error al crear proveedor" })
  }
}

// Actualizar un proveedor
export const updateSupplier = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  try {
    const { id } = req.params
    const { cuit = "", nombre, telefono = "", direccion = "" } = req.body

    if (Number.parseInt(id) === 1) {
      return res.status(400).json({ message: "No se puede editar el proveedor por defecto." })
    }

    if (nombre.toLowerCase().trim() === "sin proveedor") {
      return res.status(400).json({ message: "El nombre 'Sin Proveedor' está reservado." })
    }

    const [existing] = await pool.query("SELECT id FROM proveedores WHERE id = ? AND activo = TRUE", [id])
    if (existing.length === 0) {
      return res.status(404).json({ message: "Proveedor no encontrado." })
    }

    const [nameCheck] = await pool.query("SELECT id FROM proveedores WHERE nombre = ? AND id != ?", [nombre, id])
    if (nameCheck.length > 0) {
      return res.status(400).json({ message: "El nombre de proveedor ya existe." })
    }

    if (cuit.trim()) {
      const [cuitCheck] = await pool.query("SELECT id FROM proveedores WHERE cuit = ? AND id != ?", [cuit, id])
      if (cuitCheck.length > 0) {
        return res.status(400).json({ message: "El CUIT ya existe." })
      }
    }

    await pool.query(`UPDATE proveedores SET cuit = ?, nombre = ?, telefono = ?, direccion = ? WHERE id = ?`, [
      cuit,
      nombre,
      telefono,
      direccion,
      id,
    ])

    res.status(200).json({ message: "Proveedor actualizado exitosamente" })
  } catch (error) {
    console.error("Error al actualizar proveedor:", error)
    res.status(500).json({ message: "Error al actualizar proveedor" })
  }
}

// Eliminar un proveedor (soft delete)
export const deleteSupplier = async (req, res) => {
  try {
    const { id } = req.params

    if (Number.parseInt(id) === 1) {
      return res.status(400).json({ message: "No se puede eliminar el proveedor por defecto." })
    }

    const [existing] = await pool.query("SELECT id FROM proveedores WHERE id = ? AND activo = TRUE", [id])
    if (existing.length === 0) {
      return res.status(404).json({ message: "Proveedor no encontrado." })
    }

    const [productsUsing] = await pool.query(
      "SELECT COUNT(*) as count FROM productos WHERE proveedor_id = ? AND activo = TRUE",
      [id],
    )

    if (productsUsing[0].count > 0) {
      return res.status(400).json({
        message: "No se puede eliminar. Reasigne los productos de este proveedor a 'Sin Proveedor' primero.",
      })
    }

    await pool.query("UPDATE proveedores SET activo = FALSE WHERE id = ?", [id])

    res.status(200).json({ message: "Proveedor eliminado exitosamente" })
  } catch (error) {
    console.error("Error al eliminar proveedor:", error)
    res.status(500).json({ message: "Error al eliminar proveedor" })
  }
}

// Buscar proveedor por nombre, CUIT, teléfono o dirección (para autocompletado)
export const searchSuppliers = async (req, res) => {
  try {
    const { term } = req.query

    if (!term || term.length < 2) {
      return res.status(200).json([])
    }

    const [suppliers] = await pool.query(
      `
      SELECT 
        id, cuit, nombre, telefono, direccion
      FROM proveedores
      WHERE (nombre LIKE ? OR cuit LIKE ? OR telefono LIKE ? OR direccion LIKE ?)
      AND activo = TRUE
      ORDER BY nombre ASC
      LIMIT 10
      `,
      [`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`],
    )

    res.status(200).json(suppliers)
  } catch (error) {
    console.error("Error al buscar proveedores:", error)
    res.status(500).json({ message: "Error al buscar proveedores" })
  }
}