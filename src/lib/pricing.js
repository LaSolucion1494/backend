/**
 * Obtiene la configuración de precios desde la base de datos.
 * @param {object} connection - La conexión a la base de datos (puede ser 'pool' o una conexión de transacción).
 * @returns {Promise<object>} Un objeto con la configuración de precios.
 */
export const getPricingConfig = async (connection) => {
  try {
    const [configRows] = await connection.query(`
      SELECT clave, valor, tipo FROM configuracion 
      WHERE clave IN ('rentabilidad', 'iva', 'ingresos_brutos', 'otros_impuestos', 'stock_minimo_default')
    `)

    // Configuración por defecto con valores seguros
    const config = {
      rentabilidad: 40,
      iva: 21,
      ingresos_brutos: 0,
      otros_impuestos: 0,
      stock_minimo: 5,
    }

    configRows.forEach((item) => {
      if (item.tipo === "numero" && item.valor !== null && item.valor !== undefined) {
        const parsedValue = Number.parseFloat(item.valor)
        // Solo asignar si el valor parseado es un número válido
        if (!isNaN(parsedValue) && isFinite(parsedValue)) {
          // Mapear stock_minimo_default a stock_minimo para compatibilidad
          const key = item.clave === "stock_minimo_default" ? "stock_minimo" : item.clave
          config[key] = parsedValue
        } else {
          console.warn(`Valor inválido para configuración ${item.clave}: ${item.valor}. Usando valor por defecto.`)
        }
      }
    })

    // Validar que todos los valores sean números válidos
    Object.keys(config).forEach((key) => {
      if (isNaN(config[key]) || !isFinite(config[key]) || config[key] < 0) {
        console.warn(`Configuración ${key} tiene valor inválido: ${config[key]}. Usando valor por defecto.`)
        // Restaurar valores por defecto seguros
        switch (key) {
          case "rentabilidad":
            config[key] = 40
            break
          case "iva":
            config[key] = 21
            break
          case "ingresos_brutos":
            config[key] = 0
            break
          case "otros_impuestos":
            config[key] = 0
            break
          case "stock_minimo":
            config[key] = 1
            break
          default:
            config[key] = 0
        }
      }
    })

    return config
  } catch (error) {
    console.error("Error al obtener configuración de precios:", error)
    // Devolver configuración por defecto en caso de error
    return {
      rentabilidad: 40,
      iva: 21,
      ingresos_brutos: 0,
      otros_impuestos: 0,
      stock_minimo: 1,
    }
  }
}

/**
 * Valida que un número sea válido para cálculos de precios
 * @param {any} value - Valor a validar
 * @param {number} defaultValue - Valor por defecto si no es válido
 * @returns {number} Número válido
 */
const validateNumber = (value, defaultValue = 0) => {
  const num = Number(value)
  return isNaN(num) || !isFinite(num) || num < 0 ? defaultValue : num
}

/**
 * Calcula el precio de venta final basado en el costo y la configuración.
 * NUEVA LÓGICA CORREGIDA:
 * 1. Costo base
 * 2. Calcular IVA sobre costo base
 * 3. Calcular Ingresos Brutos sobre costo base
 * 4. Sumar costo + IVA + ingresos brutos = precio nuevo
 * 5. Calcular rentabilidad sobre precio nuevo
 * 6. Sumar rentabilidad al precio nuevo
 * 7. Calcular otros impuestos sobre este resultado
 * 8. Sumar otros impuestos para obtener precio final
 *
 * @param {number} costPrice - El precio de costo del producto.
 * @param {object} config - El objeto de configuración de precios.
 * @returns {number} El precio de venta final, redondeado a 2 decimales.
 */
export const calculateSalePrice = (costPrice, config) => {
  // Validar precio de costo
  const validCostPrice = validateNumber(costPrice, 0)

  if (validCostPrice <= 0) {
    return 0
  }

  // Validar configuración y usar valores por defecto si es necesario
  const validConfig = {
    rentabilidad: validateNumber(config?.rentabilidad, 40),
    iva: validateNumber(config?.iva, 21),
    ingresos_brutos: validateNumber(config?.ingresos_brutos, 0),
    otros_impuestos: validateNumber(config?.otros_impuestos, 0),
  }

  try {
    // NUEVA LÓGICA DE CÁLCULO CORREGIDA:

    // 1. Calcular IVA directamente sobre el costo base
    const ivaMonto = validCostPrice * (validConfig.iva / 100)

    // 2. Calcular ingresos brutos directamente sobre el costo base
    const ingresosBrutosMonto = validCostPrice * (validConfig.ingresos_brutos / 100)

    // 3. Sumar costo + IVA + ingresos brutos = precio nuevo
    const precioNuevo = validCostPrice + ivaMonto + ingresosBrutosMonto

    // 4. Calcular rentabilidad sobre el precio nuevo
    const rentabilidadMonto = precioNuevo * (validConfig.rentabilidad / 100)

    // 5. Sumar rentabilidad al precio nuevo
    const precioConRentabilidad = precioNuevo + rentabilidadMonto

    // 6. Calcular otros impuestos sobre el resultado con rentabilidad
    const otrosImpuestosMonto = precioConRentabilidad * (validConfig.otros_impuestos / 100)

    // 7. Precio final
    const precioFinal = precioConRentabilidad + otrosImpuestosMonto

    // Validar que el resultado final sea un número válido
    if (isNaN(precioFinal) || !isFinite(precioFinal) || precioFinal < 0) {
      console.error("Error en cálculo de precio:", {
        costPrice: validCostPrice,
        config: validConfig,
        precioFinal,
      })
      return 0
    }

    const resultado = Math.round(precioFinal * 100) / 100
    return resultado
  } catch (error) {
    console.error("Error al calcular precio de venta:", error, {
      costPrice: validCostPrice,
      config: validConfig,
    })
    return 0
  }
}

/**
 * Genera un desglose detallado del cálculo del precio.
 * NUEVA LÓGICA CORREGIDA:
 * 1. Costo base
 * 2. Calcular IVA sobre costo base
 * 3. Calcular Ingresos Brutos sobre costo base
 * 4. Sumar costo + IVA + ingresos brutos = precio nuevo
 * 5. Calcular rentabilidad sobre precio nuevo
 * 6. Sumar rentabilidad al precio nuevo
 * 7. Calcular otros impuestos sobre este resultado
 * 8. Sumar otros impuestos para obtener precio final
 *
 * @param {number} costPrice - El precio de costo del producto.
 * @param {object} config - El objeto de configuración de precios.
 * @returns {object} Un objeto con el desglose del precio.
 */
export const getPriceBreakdown = (costPrice, config) => {
  // Validar precio de costo
  const validCostPrice = validateNumber(costPrice, 0)

  if (validCostPrice <= 0) {
    return {
      costo: 0,
      iva: 0,
      ingresosBrutos: 0,
      precioNuevo: 0,
      rentabilidad: 0,
      precioConRentabilidad: 0,
      otrosImpuestos: 0,
      precioFinal: 0,
      porcentajes: {
        rentabilidad: 40,
        iva: 21,
        ingresos_brutos: 0,
        otros_impuestos: 0,
      },
    }
  }

  // Validar configuración
  const validConfig = {
    rentabilidad: validateNumber(config?.rentabilidad, 40),
    iva: validateNumber(config?.iva, 21),
    ingresos_brutos: validateNumber(config?.ingresos_brutos, 0),
    otros_impuestos: validateNumber(config?.otros_impuestos, 0),
  }

  try {
    // NUEVA LÓGICA DE CÁLCULO CORREGIDA CON DESGLOSE DETALLADO:

    // 1. Calcular IVA directamente sobre el costo base
    const ivaMonto = validCostPrice * (validConfig.iva / 100)

    // 2. Calcular ingresos brutos directamente sobre el costo base
    const ingresosBrutosMonto = validCostPrice * (validConfig.ingresos_brutos / 100)

    // 3. Sumar costo + IVA + ingresos brutos = precio nuevo
    const precioNuevo = validCostPrice + ivaMonto + ingresosBrutosMonto

    // 4. Calcular rentabilidad sobre el precio nuevo
    const rentabilidadMonto = precioNuevo * (validConfig.rentabilidad / 100)

    // 5. Sumar rentabilidad al precio nuevo
    const precioConRentabilidad = precioNuevo + rentabilidadMonto

    // 6. Calcular otros impuestos sobre el resultado con rentabilidad
    const otrosImpuestosMonto = precioConRentabilidad * (validConfig.otros_impuestos / 100)

    // 7. Precio final
    const precioFinal = precioConRentabilidad + otrosImpuestosMonto

    return {
      costo: Math.round(validCostPrice * 100) / 100,
      iva: Math.round(ivaMonto * 100) / 100,
      ingresosBrutos: Math.round(ingresosBrutosMonto * 100) / 100,
      precioNuevo: Math.round(precioNuevo * 100) / 100,
      rentabilidad: Math.round(rentabilidadMonto * 100) / 100,
      precioConRentabilidad: Math.round(precioConRentabilidad * 100) / 100,
      otrosImpuestos: Math.round(otrosImpuestosMonto * 100) / 100,
      precioFinal: Math.round(precioFinal * 100) / 100,
      porcentajes: validConfig,
    }
  } catch (error) {
    console.error("Error al generar desglose de precios:", error)
    return {
      costo: validCostPrice,
      iva: 0,
      ingresosBrutos: 0,
      precioNuevo: validCostPrice,
      rentabilidad: 0,
      precioConRentabilidad: validCostPrice,
      otrosImpuestos: 0,
      precioFinal: validCostPrice,
      porcentajes: validConfig,
    }
  }
}
