import pool from "../db.js"
import { validationResult } from "express-validator"
import { getPricingConfig, calculateSalePrice } from "../lib/pricing.js"

/**
 * Valida que un precio sea un número válido
 * @param {any} price - Precio a validar
 * @returns {boolean} True si es válido
 */
const isValidPrice = (price) => {
  const num = Number(price)
  return !isNaN(num) && isFinite(num) && num >= 0
}

/**
 * Recalcula los precios de venta para todos los productos activos.
 * Utiliza una transacción para garantizar la atomicidad de la operación.
 * @param {object} connection - La conexión a la base de datos.
 * @returns {Promise<object>} Resultado de la operación con estadísticas.
 */
const recalculateAllProductPrices = async (connection) => {
  const startTime = Date.now()
  let updatedCount = 0
  let errorCount = 0
  const errors = []

  try {
    // 1. Obtener la configuración de precios más reciente
    const pricingConfig = await getPricingConfig(connection)
    // 2. Obtener todos los productos activos que necesitan actualización
    const [products] = await connection.query(`
      SELECT id, codigo, nombre, precio_costo 
      FROM productos 
      WHERE activo = TRUE 
      ORDER BY id
    `)

    if (products.length === 0) {
      return {
        updatedCount: 0,
        errorCount: 0,
        errors: [],
        executionTime: Date.now() - startTime,
        message: "No hay productos activos para actualizar",
      }
    }
    // 3. Procesar productos en lotes para evitar problemas de memoria
    const batchSize = 100
    for (let i = 0; i < products.length; i += batchSize) {
      const batch = products.slice(i, i + batchSize)

      for (const product of batch) {
        try {
          // Validar precio de costo
          if (!isValidPrice(product.precio_costo)) {
            const error = `Producto ID ${product.id} (${product.codigo}): precio_costo inválido (${product.precio_costo})`
            console.warn(error)
            errors.push(error)
            errorCount++
            continue
          }

          // Calcular nuevo precio de venta
          const newSalePrice = calculateSalePrice(product.precio_costo, pricingConfig)

          // Validar que el precio calculado sea válido
          if (!isValidPrice(newSalePrice)) {
            const error = `Producto ID ${product.id} (${product.codigo}): precio calculado inválido (${newSalePrice})`
            console.error(error)
            errors.push(error)
            errorCount++
            continue
          }

          // Actualizar el producto
          await connection.query("UPDATE productos SET precio_venta = ? WHERE id = ?", [newSalePrice, product.id])

          updatedCount++

        } catch (productError) {
          const error = `Error procesando producto ID ${product.id} (${product.codigo}): ${productError.message}`
          console.error(error)
          errors.push(error)
          errorCount++
        }
      }
    }

    const executionTime = Date.now() - startTime
    return {
      updatedCount,
      errorCount,
      errors: errors.slice(0, 10), // Solo los primeros 10 errores para no saturar
      executionTime,
      totalProducts: products.length,
      config: pricingConfig,
    }
  } catch (error) {
    console.error("Error al recalcular los precios de los productos:", error)
    throw error
  }
}

// Obtener toda la configuración del sistema
export const getConfig = async (req, res) => {
  try {
    const [configRows] = await pool.query(
      "SELECT clave, valor, descripcion, tipo FROM configuracion ORDER BY clave ASC",
    )

    const configObj = {}
    configRows.forEach((item) => {
      let valor = item.valor
      if (item.tipo === "numero") {
        const parsedValue = Number.parseFloat(valor)
        valor = isNaN(parsedValue) ? 0 : parsedValue
      } else if (item.tipo === "booleano") {
        valor = valor === "true" || valor === "1"
      }
      configObj[item.clave] = valor
    })

    res.status(200).json(configObj)
  } catch (error) {
    console.error("Error al obtener configuración:", error)
    res.status(500).json({ message: "Error al obtener la configuración del sistema" })
  }
}

// Actualizar una o varias configuraciones
export const updateConfig = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  const connection = await pool.getConnection()
  try {
    const { configs, recalculatePrices = false } = req.body // Array de { clave, valor }

    if (!Array.isArray(configs) || configs.length === 0) {
      return res.status(400).json({ message: "Se esperaba un array de configuraciones no vacío" })
    }

    await connection.beginTransaction()

    const pricingKeys = ["rentabilidad", "iva", "ingresos_brutos", "otros_impuestos"]
    let pricingConfigChanged = false

    // Validar y actualizar configuraciones
    for (const config of configs) {
      const { clave, valor } = config

      // Validar que el valor sea válido para configuraciones numéricas
      if (pricingKeys.includes(clave)) {
        const numValue = Number.parseFloat(valor)
        if (isNaN(numValue) || !isFinite(numValue) || numValue < 0) {
          await connection.rollback()
          return res.status(400).json({
            message: `Valor inválido para ${clave}: ${valor}. Debe ser un número positivo.`,
          })
        }
        pricingConfigChanged = true
      }

      await connection.query("UPDATE configuracion SET valor = ? WHERE clave = ?", [valor.toString(), clave])
    }

    let recalculateResult = null
    // Si una configuración de precios cambió y se solicitó recalcular
    if (pricingConfigChanged && recalculatePrices) {
      try {
        recalculateResult = await recalculateAllProductPrices(connection)
      } catch (recalculateError) {
        console.error("Error durante recálculo:", recalculateError)
        await connection.rollback()
        return res.status(500).json({
          message: "Error al recalcular precios: " + recalculateError.message,
        })
      }
    }

    await connection.commit()

    const response = {
      message: "Configuración actualizada exitosamente",
      pricingConfigChanged,
      recalculated: recalculatePrices && pricingConfigChanged,
    }

    if (recalculateResult) {
      response.updatedProductsCount = recalculateResult.updatedCount
      response.errorCount = recalculateResult.errorCount
      response.executionTime = recalculateResult.executionTime

      if (recalculateResult.errors.length > 0) {
        response.warnings = recalculateResult.errors
      }
    }

    res.status(200).json(response)
  } catch (error) {
    await connection.rollback()
    console.error("Error al actualizar configuración:", error)
    res.status(500).json({ message: "Error al actualizar la configuración" })
  } finally {
    connection.release()
  }
}

// Endpoint para forzar el recálculo de todos los precios manualmente
export const recalculateAllPrices = async (req, res) => {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()

    const result = await recalculateAllProductPrices(connection)

    await connection.commit()

    const message = `Precios de venta recalculados exitosamente. ${result.updatedCount} productos actualizados${result.errorCount > 0 ? `, ${result.errorCount} errores` : ""}.`

    const response = {
      message,
      updatedProductsCount: result.updatedCount,
      errorCount: result.errorCount,
      executionTime: result.executionTime,
      totalProducts: result.totalProducts,
    }

    if (result.errors.length > 0) {
      response.warnings = result.errors
    }

    res.status(200).json(response)
  } catch (error) {
    await connection.rollback()
    console.error("Error al recalcular precios:", error)
    res.status(500).json({ message: "Error al recalcular los precios de venta: " + error.message })
  } finally {
    connection.release()
  }
}
