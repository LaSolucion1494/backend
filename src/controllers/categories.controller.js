import pool from "../db.js"
import { validationResult } from "express-validator"

// Función para asegurar que existe la categoría por defecto
const ensureDefaultCategory = async () => {
  try {
    const [existing] = await pool.query("SELECT id FROM categorias WHERE id = 1")
    if (existing.length === 0) {
      await pool.query(`
        INSERT INTO categorias (id, nombre, descripcion, activo) 
        VALUES (1, 'Sin Categoría', 'Categoría por defecto', TRUE)
      `)
      await pool.query("ALTER TABLE categorias AUTO_INCREMENT = 2")
    } else {
      await pool.query(`
        UPDATE categorias SET nombre = 'Sin Categoría', activo = TRUE WHERE id = 1
      `)
    }
  } catch (error) {
    console.error("Error al asegurar categoría por defecto:", error)
  }
}

// Obtener todas las categorías con filtros y paginación
export const getCategories = async (req, res) => {
  try {
    await ensureDefaultCategory()

    const { search = "", limit = 10, offset = 0 } = req.query

    let baseQuery = `FROM categorias WHERE activo = TRUE`
    const queryParams = []

    if (search) {
      baseQuery += ` AND (nombre LIKE ? OR descripcion LIKE ?)`
      const searchTerm = `%${search}%`
      queryParams.push(searchTerm, searchTerm)
    }

    const countQuery = `SELECT COUNT(*) as total ${baseQuery}`
    const [[{ total }]] = await pool.query(countQuery, queryParams)

    const dataQuery = `
      SELECT id, nombre, descripcion 
      ${baseQuery}
      ORDER BY CASE WHEN id = 1 THEN 0 ELSE 1 END, nombre ASC
      LIMIT ? OFFSET ?
    `
    const finalDataParams = [...queryParams, Number.parseInt(limit), Number.parseInt(offset)]
    const [categories] = await pool.query(dataQuery, finalDataParams)

    res.status(200).json({
      data: categories,
      pagination: {
        totalItems: total,
        totalPages: Math.ceil(total / limit),
        currentPage: Math.floor(offset / limit) + 1,
        itemsPerPage: Number.parseInt(limit),
      },
    })
  } catch (error) {
    console.error("Error al obtener categorías:", error)
    res.status(500).json({ message: "Error al obtener categorías" })
  }
}

// Crear una nueva categoría
export const createCategory = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  try {
    const { nombre, descripcion = "" } = req.body

    if (nombre.toLowerCase().trim() === "sin categoría") {
      return res.status(400).json({ message: "El nombre 'Sin Categoría' está reservado." })
    }

    const [existing] = await pool.query("SELECT id FROM categorias WHERE nombre = ?", [nombre])
    if (existing.length > 0) {
      return res.status(400).json({ message: "La categoría ya existe." })
    }

    const [result] = await pool.query("INSERT INTO categorias (nombre, descripcion) VALUES (?, ?)", [
      nombre,
      descripcion,
    ])

    res.status(201).json({
      message: "Categoría creada exitosamente",
      id: result.insertId,
    })
  } catch (error) {
    console.error("Error al crear categoría:", error)
    res.status(500).json({ message: "Error al crear categoría" })
  }
}

// Actualizar una categoría
export const updateCategory = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  try {
    const { id } = req.params
    const { nombre, descripcion = "" } = req.body

    if (Number.parseInt(id) === 1) {
      return res.status(400).json({ message: "No se puede editar la categoría por defecto." })
    }

    if (nombre.toLowerCase().trim() === "sin categoría") {
      return res.status(400).json({ message: "El nombre 'Sin Categoría' está reservado." })
    }

    const [existing] = await pool.query("SELECT id FROM categorias WHERE id = ? AND activo = TRUE", [id])
    if (existing.length === 0) {
      return res.status(404).json({ message: "Categoría no encontrada." })
    }

    const [nameCheck] = await pool.query("SELECT id FROM categorias WHERE nombre = ? AND id != ?", [nombre, id])
    if (nameCheck.length > 0) {
      return res.status(400).json({ message: "El nombre de categoría ya existe." })
    }

    await pool.query("UPDATE categorias SET nombre = ?, descripcion = ? WHERE id = ?", [nombre, descripcion, id])

    res.status(200).json({ message: "Categoría actualizada exitosamente" })
  } catch (error) {
    console.error("Error al actualizar categoría:", error)
    res.status(500).json({ message: "Error al actualizar categoría" })
  }
}

// Eliminar una categoría (soft delete)
export const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params

    if (Number.parseInt(id) === 1) {
      return res.status(400).json({ message: "No se puede eliminar la categoría por defecto." })
    }

    const [existing] = await pool.query("SELECT id FROM categorias WHERE id = ? AND activo = TRUE", [id])
    if (existing.length === 0) {
      return res.status(404).json({ message: "Categoría no encontrada." })
    }

    const [productsUsing] = await pool.query(
      "SELECT COUNT(*) as count FROM productos WHERE categoria_id = ? AND activo = TRUE",
      [id],
    )

    if (productsUsing[0].count > 0) {
      return res.status(400).json({
        message: "No se puede eliminar. Reasigne los productos de esta categoría a 'Sin Categoría' primero.",
      })
    }

    await pool.query("UPDATE categorias SET activo = FALSE WHERE id = ?", [id])

    res.status(200).json({ message: "Categoría eliminada exitosamente" })
  } catch (error) {
    console.error("Error al eliminar categoría:", error)
    res.status(500).json({ message: "Error al eliminar categoría" })
  }
}
