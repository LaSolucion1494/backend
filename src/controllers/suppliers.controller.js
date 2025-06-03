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

      // Asegurar que el AUTO_INCREMENT comience desde 2
      await pool.query("ALTER TABLE proveedores AUTO_INCREMENT = 2")
    } else {
      // Asegurar que el proveedor por defecto esté activo y tenga el nombre correcto
      await pool.query(`
        UPDATE proveedores 
        SET nombre = 'Sin Proveedor', activo = TRUE 
        WHERE id = 1
      `)
    }
  } catch (error) {
    console.error("Error al crear proveedor por defecto:", error)
  }
}

// Obtener todos los proveedores activos
export const getSuppliers = async (req, res) => {
  try {
    // Asegurar que existe el proveedor por defecto
    await ensureDefaultSupplier()

    const [suppliers] = await pool.query(`
      SELECT id, cuit, nombre, telefono, direccion 
      FROM proveedores 
      WHERE activo = TRUE 
      ORDER BY 
        CASE WHEN id = 1 THEN 0 ELSE 1 END,
        nombre ASC
    `)

    res.status(200).json(suppliers)
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

    // Verificar que no se intente crear otro proveedor con el nombre reservado
    if (nombre.toLowerCase().trim() === "sin proveedor") {
      return res.status(400).json({ message: "El nombre 'Sin Proveedor' está reservado para el sistema" })
    }

    // Verificar si el proveedor ya existe por nombre
    const [existing] = await pool.query("SELECT id FROM proveedores WHERE nombre = ?", [nombre])

    if (existing.length > 0) {
      return res.status(400).json({ message: "El proveedor ya existe" })
    }

    // Verificar si el CUIT ya existe (si se proporciona)
    if (cuit.trim()) {
      const [existingCuit] = await pool.query("SELECT id FROM proveedores WHERE cuit = ?", [cuit])
      if (existingCuit.length > 0) {
        return res.status(400).json({ message: "El CUIT ya existe" })
      }
    }

    const [result] = await pool.query(
      `
      INSERT INTO proveedores (cuit, nombre, telefono, direccion) 
      VALUES (?, ?, ?, ?)
    `,
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

    // Verificar que no se intente editar el proveedor por defecto
    if (Number.parseInt(id) === 1) {
      return res.status(400).json({ message: "No se puede editar el proveedor por defecto del sistema" })
    }

    // Verificar que no se intente usar el nombre reservado
    if (nombre.toLowerCase().trim() === "sin proveedor") {
      return res.status(400).json({ message: "El nombre 'Sin Proveedor' está reservado para el sistema" })
    }

    // Verificar si el proveedor existe
    const [existing] = await pool.query("SELECT id FROM proveedores WHERE id = ? AND activo = TRUE", [id])

    if (existing.length === 0) {
      return res.status(404).json({ message: "Proveedor no encontrado" })
    }

    // Verificar si el nombre ya existe en otro proveedor
    const [nameCheck] = await pool.query("SELECT id FROM proveedores WHERE nombre = ? AND id != ?", [nombre, id])

    if (nameCheck.length > 0) {
      return res.status(400).json({ message: "El nombre de proveedor ya existe" })
    }

    // Verificar si el CUIT ya existe en otro proveedor (si se proporciona)
    if (cuit.trim()) {
      const [cuitCheck] = await pool.query("SELECT id FROM proveedores WHERE cuit = ? AND id != ?", [cuit, id])
      if (cuitCheck.length > 0) {
        return res.status(400).json({ message: "El CUIT ya existe" })
      }
    }

    await pool.query(
      `
      UPDATE proveedores SET 
        cuit = ?, nombre = ?, telefono = ?, direccion = ? 
      WHERE id = ?
    `,
      [cuit, nombre, telefono, direccion, id],
    )

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

    // Verificar que no se intente eliminar el proveedor por defecto
    if (Number.parseInt(id) === 1) {
      return res.status(400).json({ message: "No se puede eliminar el proveedor por defecto del sistema" })
    }

    // Verificar si el proveedor existe
    const [existing] = await pool.query("SELECT id FROM proveedores WHERE id = ? AND activo = TRUE", [id])

    if (existing.length === 0) {
      return res.status(404).json({ message: "Proveedor no encontrado" })
    }

    // Verificar si hay productos usando este proveedor
    const [productsUsing] = await pool.query(
      "SELECT COUNT(*) as count FROM productos WHERE proveedor_id = ? AND activo = TRUE",
      [id],
    )

    if (productsUsing[0].count > 0) {
      return res.status(400).json({
        message:
          "No se puede eliminar el proveedor porque tiene productos asociados. Puedes cambiar los productos al proveedor 'Sin Proveedor' antes de eliminarlo.",
      })
    }

    await pool.query("UPDATE proveedores SET activo = FALSE WHERE id = ?", [id])

    res.status(200).json({ message: "Proveedor eliminado exitosamente" })
  } catch (error) {
    console.error("Error al eliminar proveedor:", error)
    res.status(500).json({ message: "Error al eliminar proveedor" })
  }
}
