import pool from "../db.js"
import { validationResult } from "express-validator"

// Función para asegurar que existe la categoría por defecto
const ensureDefaultCategory = async () => {
  try {
    const [existing] = await pool.query("SELECT id FROM categorias WHERE id = 1")

    if (existing.length === 0) {
      await pool.query(`
        INSERT INTO categorias (id, nombre, descripcion, activo) 
        VALUES (1, 'Sin Categoría', 'Categoría por defecto para productos sin categoría específica', TRUE)
      `)

      // Asegurar que el AUTO_INCREMENT comience desde 2
      await pool.query("ALTER TABLE categorias AUTO_INCREMENT = 2")
    } else {
      // Asegurar que la categoría por defecto esté activa y tenga el nombre correcto
      await pool.query(`
        UPDATE categorias 
        SET nombre = 'Sin Categoría', 
            descripcion = 'Categoría por defecto para productos sin categoría específica',
            activo = TRUE 
        WHERE id = 1
      `)
    }
  } catch (error) {
    console.error("Error al crear categoría por defecto:", error)
  }
}

// Obtener todas las categorías activas
export const getCategories = async (req, res) => {
  try {
    // Asegurar que existe la categoría por defecto
    await ensureDefaultCategory()

    const [categories] = await pool.query(`
      SELECT id, nombre, descripcion 
      FROM categorias 
      WHERE activo = TRUE 
      ORDER BY 
        CASE WHEN id = 1 THEN 0 ELSE 1 END,
        nombre ASC
    `)

    res.status(200).json(categories)
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

    // Verificar que no se intente crear otra categoría con el nombre reservado
    if (nombre.toLowerCase().trim() === "sin categoría") {
      return res.status(400).json({ message: "El nombre 'Sin Categoría' está reservado para el sistema" })
    }

    // Verificar si la categoría ya existe
    const [existing] = await pool.query("SELECT id FROM categorias WHERE nombre = ?", [nombre])

    if (existing.length > 0) {
      return res.status(400).json({ message: "La categoría ya existe" })
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

    // Verificar que no se intente editar la categoría por defecto
    if (Number.parseInt(id) === 1) {
      return res.status(400).json({ message: "No se puede editar la categoría por defecto del sistema" })
    }

    // Verificar que no se intente usar el nombre reservado
    if (nombre.toLowerCase().trim() === "sin categoría") {
      return res.status(400).json({ message: "El nombre 'Sin Categoría' está reservado para el sistema" })
    }

    // Verificar si la categoría existe
    const [existing] = await pool.query("SELECT id FROM categorias WHERE id = ? AND activo = TRUE", [id])

    if (existing.length === 0) {
      return res.status(404).json({ message: "Categoría no encontrada" })
    }

    // Verificar si el nombre ya existe en otra categoría
    const [nameCheck] = await pool.query("SELECT id FROM categorias WHERE nombre = ? AND id != ?", [nombre, id])

    if (nameCheck.length > 0) {
      return res.status(400).json({ message: "El nombre de categoría ya existe" })
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

    // Verificar que no se intente eliminar la categoría por defecto
    if (Number.parseInt(id) === 1) {
      return res.status(400).json({ message: "No se puede eliminar la categoría por defecto del sistema" })
    }

    // Verificar si la categoría existe
    const [existing] = await pool.query("SELECT id FROM categorias WHERE id = ? AND activo = TRUE", [id])

    if (existing.length === 0) {
      return res.status(404).json({ message: "Categoría no encontrada" })
    }

    // Verificar si hay productos usando esta categoría
    const [productsUsing] = await pool.query(
      "SELECT COUNT(*) as count FROM productos WHERE categoria_id = ? AND activo = TRUE",
      [id],
    )

    if (productsUsing[0].count > 0) {
      return res.status(400).json({
        message:
          "No se puede eliminar la categoría porque tiene productos asociados. Puedes cambiar los productos a 'Sin Categoría' antes de eliminarla.",
      })
    }

    await pool.query("UPDATE categorias SET activo = FALSE WHERE id = ?", [id])

    res.status(200).json({ message: "Categoría eliminada exitosamente" })
  } catch (error) {
    console.error("Error al eliminar categoría:", error)
    res.status(500).json({ message: "Error al eliminar categoría" })
  }
}
