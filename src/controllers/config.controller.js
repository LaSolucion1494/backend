import pool from "../db.js"
import { validationResult } from "express-validator"

// Obtener toda la configuración
export const getConfig = async (req, res) => {
  try {
    const [config] = await pool.query(`
      SELECT clave, valor, descripcion, tipo 
      FROM configuracion 
      ORDER BY clave ASC
    `)

    // Convertir a objeto para facilitar el uso en frontend
    const configObj = {}
    config.forEach((item) => {
      let valor = item.valor

      // Convertir valores según el tipo
      if (item.tipo === "numero") {
        valor = Number.parseFloat(valor)
      } else if (item.tipo === "booleano") {
        valor = valor === "true" || valor === "1"
      }

      configObj[item.clave] = valor
    })

    res.status(200).json(configObj)
  } catch (error) {
    console.error("Error al obtener configuración:", error)
    res.status(500).json({ message: "Error al obtener configuración" })
  }
}

// Obtener una configuración específica
export const getConfigByKey = async (req, res) => {
  try {
    const { key } = req.params

    const [config] = await pool.query("SELECT clave, valor, descripcion, tipo FROM configuracion WHERE clave = ?", [
      key,
    ])

    if (config.length === 0) {
      return res.status(404).json({ message: "Configuración no encontrada" })
    }

    let valor = config[0].valor

    // Convertir valor según el tipo
    if (config[0].tipo === "numero") {
      valor = Number.parseFloat(valor)
    } else if (config[0].tipo === "booleano") {
      valor = valor === "true" || valor === "1"
    }

    res.status(200).json({
      clave: config[0].clave,
      valor: valor,
      descripcion: config[0].descripcion,
      tipo: config[0].tipo,
    })
  } catch (error) {
    console.error("Error al obtener configuración:", error)
    res.status(500).json({ message: "Error al obtener configuración" })
  }
}

// Actualizar configuración
export const updateConfig = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  try {
    const { configs } = req.body // Array de { clave, valor }

    if (!Array.isArray(configs)) {
      return res.status(400).json({ message: "Se esperaba un array de configuraciones" })
    }

    const connection = await pool.getConnection()

    try {
      await connection.beginTransaction()

      for (const config of configs) {
        const { clave, valor } = config

        // Verificar si la configuración existe
        const [existing] = await connection.query("SELECT id FROM configuracion WHERE clave = ?", [clave])

        if (existing.length === 0) {
          await connection.rollback()
          return res.status(404).json({
            message: `Configuración '${clave}' no encontrada`,
          })
        }

        // Actualizar configuración
        await connection.query("UPDATE configuracion SET valor = ? WHERE clave = ?", [valor.toString(), clave])
      }

      await connection.commit()
      res.status(200).json({ message: "Configuración actualizada exitosamente" })
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  } catch (error) {
    console.error("Error al actualizar configuración:", error)
    res.status(500).json({ message: "Error al actualizar configuración" })
  }
}

// Actualizar una configuración específica
export const updateConfigByKey = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  try {
    const { key } = req.params
    const { valor } = req.body

    // Verificar si la configuración existe
    const [existing] = await pool.query("SELECT id FROM configuracion WHERE clave = ?", [key])

    if (existing.length === 0) {
      return res.status(404).json({ message: "Configuración no encontrada" })
    }

    // Actualizar configuración
    await pool.query("UPDATE configuracion SET valor = ? WHERE clave = ?", [valor.toString(), key])

    res.status(200).json({ message: "Configuración actualizada exitosamente" })
  } catch (error) {
    console.error("Error al actualizar configuración:", error)
    res.status(500).json({ message: "Error al actualizar configuración" })
  }
}
