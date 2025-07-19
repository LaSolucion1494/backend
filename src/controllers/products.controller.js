import pool from "../db.js"
import { validationResult } from "express-validator"
import { getPricingConfig, calculateSalePrice, getPriceBreakdown } from "../lib/pricing.js"

// Función para asegurar que existen los valores por defecto (categoría y proveedor)
const ensureDefaults = async () => {
  try {
    // Asegurar categoría por defecto
    const [existingCategory] = await pool.query("SELECT id FROM categorias WHERE id = 1")
    if (existingCategory.length === 0) {
      await pool.query(`
        INSERT INTO categorias (id, nombre, descripcion, activo) 
        VALUES (1, 'Sin Categoría', 'Categoría por defecto para productos sin categoría específica', TRUE)
      `)
      await pool.query("ALTER TABLE categorias AUTO_INCREMENT = 2")
    }

    // Asegurar proveedor por defecto
    const [existingSupplier] = await pool.query("SELECT id FROM proveedores WHERE id = 1")
    if (existingSupplier.length === 0) {
      await pool.query(`
        INSERT INTO proveedores (id, cuit, nombre, telefono, direccion, activo) 
        VALUES (1, NULL, 'Sin Proveedor', NULL, NULL, TRUE)
      `)
      await pool.query("ALTER TABLE proveedores AUTO_INCREMENT = 2")
    }
  } catch (error) {
    console.error("Error al crear valores por defecto:", error)
  }
}

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
 * Obtiene la configuración de precios para un producto específico
 * Usa configuración personalizada si existe, sino usa la configuración global
 * @param {object} product - Producto con posible configuración personalizada
 * @param {object} connection - Conexión a la base de datos
 * @returns {Promise<object>} Configuración de precios a usar
 */
const getProductPricingConfig = async (product, connection) => {
  // Si el producto tiene configuración personalizada, usarla
  if (product && product.custom_pricing_config) {
    console.log("Usando configuración personalizada del producto:", product.custom_pricing_config)
    return {
      rentabilidad: Number(product.custom_pricing_config.rentabilidad) || 40,
      iva: Number(product.custom_pricing_config.iva) || 21,
      ingresos_brutos: Number(product.custom_pricing_config.ingresos_brutos) || 0,
      otros_impuestos: Number(product.custom_pricing_config.otros_impuestos) || 0,
    }
  }

  // Sino, usar configuración global
  console.log("Usando configuración global del sistema")
  return await getPricingConfig(connection)
}

// Buscar producto por código
export const getProductByCode = async (req, res) => {
  try {
    const { code } = req.params

    const [products] = await pool.query(
      `
      SELECT 
        p.id, p.codigo, p.nombre, p.descripcion, p.marca, p.stock, p.stock_minimo,
        p.precio_costo, p.precio_venta, p.custom_pricing_config, p.tiene_codigo_barras as tieneCodigoBarras,
        p.fecha_ingreso as fechaIngreso, p.activo, p.categoria_id, p.proveedor_id,
        COALESCE(c.nombre, 'Sin Categoría') as categoria_nombre,
        COALESCE(pr.nombre, 'Sin Proveedor') as proveedor,
        COALESCE(
          (SELECT valor FROM configuracion WHERE clave = 'stock_minimo_default'), 
          p.stock_minimo, 
          5
        ) as stock_minimo_config
      FROM productos p
      LEFT JOIN categorias c ON p.categoria_id = c.id
      LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
      WHERE p.codigo = ? AND p.activo = TRUE
    `,
      [code],
    )

    if (products.length === 0) {
      return res.status(404).json({ message: "Producto no encontrado con ese código" })
    }

    // Parsear configuración personalizada si existe
    const product = products[0]
    if (product.custom_pricing_config) {
      try {
        product.custom_pricing_config = JSON.parse(product.custom_pricing_config)
      } catch (error) {
        console.error("Error parsing custom pricing config:", error)
        product.custom_pricing_config = null
      }
    }

    res.status(200).json(product)
  } catch (error) {
    console.error("Error al buscar producto por código:", error)
    res.status(500).json({ message: "Error al buscar producto por código" })
  }
}

// ACTUALIZADO: Obtener todos los productos con filtros y PAGINACIÓN
export const getProducts = async (req, res) => {
  try {
    const {
      search = "",
      categoria = "",
      stockStatus = "todos",
      activo = "true",
      minPrice = "",
      maxPrice = "",
      sortBy = "nombre",
      sortOrder = "asc",
      limit = 10,
      offset = 0,
    } = req.query

    let baseQuery = `
      FROM productos p
      LEFT JOIN categorias c ON p.categoria_id = c.id
      LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
      WHERE 1=1
    `
    const queryParams = []

    if (activo === "true") baseQuery += ` AND p.activo = TRUE`
    else if (activo === "false") baseQuery += ` AND p.activo = FALSE`

    if (search) {
      baseQuery += ` AND (p.codigo LIKE ? OR p.nombre LIKE ? OR p.descripcion LIKE ? OR p.marca LIKE ?)`
      const searchTerm = `%${search}%`
      queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm)
    }

    if (categoria && categoria !== "Todos") {
      baseQuery += ` AND c.nombre = ?`
      queryParams.push(categoria)
    }

    if (stockStatus === "disponible") baseQuery += ` AND p.stock > 0`
    else if (stockStatus === "bajo") baseQuery += ` AND p.stock <= p.stock_minimo AND p.stock > 0`
    else if (stockStatus === "agotado") baseQuery += ` AND p.stock = 0`

    if (minPrice) {
      baseQuery += ` AND p.precio_venta >= ?`
      queryParams.push(Number.parseFloat(minPrice))
    }
    if (maxPrice) {
      baseQuery += ` AND p.precio_venta <= ?`
      queryParams.push(Number.parseFloat(maxPrice))
    }

    // Consulta de conteo
    const countQuery = `SELECT COUNT(*) as total ${baseQuery}`
    const [[{ total }]] = await pool.query(countQuery, queryParams)

    // Consulta de datos con paginación
    let dataQuery = `
      SELECT 
        p.id, p.codigo, p.nombre, p.descripcion, p.marca, p.stock, p.stock_minimo,
        p.precio_costo, p.precio_venta, p.custom_pricing_config, p.tiene_codigo_barras as tieneCodigoBarras,
        p.fecha_ingreso as fechaIngreso, p.activo, p.proveedor_id,
        COALESCE(c.nombre, 'Sin Categoría') as categoria_nombre,
        COALESCE(pr.nombre, 'Sin Proveedor') as proveedor,
        COALESCE(
          (SELECT valor FROM configuracion WHERE clave = 'stock_minimo_default'), 
          p.stock_minimo, 
          5
        ) as stock_minimo_config
      ${baseQuery}
    `

    const validSortFields = ["nombre", "codigo", "stock", "precio_costo", "precio_venta", "categoria_nombre", "marca"]
    if (validSortFields.includes(sortBy)) {
      dataQuery += ` ORDER BY ${sortBy === "categoria_nombre" ? "c.nombre" : `p.${sortBy}`} ${sortOrder === "desc" ? "DESC" : "ASC"}`
    }

    dataQuery += ` LIMIT ? OFFSET ?`
    const finalDataParams = [...queryParams, Number.parseInt(limit), Number.parseInt(offset)]
    const [products] = await pool.query(dataQuery, finalDataParams)

    // Parsear configuración personalizada para cada producto
    products.forEach((product) => {
      if (product.custom_pricing_config) {
        try {
          product.custom_pricing_config = JSON.parse(product.custom_pricing_config)
        } catch (error) {
          console.error("Error parsing custom pricing config for product", product.id, error)
          product.custom_pricing_config = null
        }
      }
    })

    res.status(200).json({
      success: true,
      data: products,
      pagination: {
        totalItems: total,
        totalPages: Math.ceil(total / limit),
        currentPage: Math.floor(offset / limit) + 1,
        itemsPerPage: Number.parseInt(limit),
      },
    })
  } catch (error) {
    console.error("Error al obtener productos:", error)
    res.status(500).json({
      success: false,
      message: "Error al obtener productos",
      error: error.message,
    })
  }
}

// Obtener un producto por ID
export const getProductById = async (req, res) => {
  try {
    const { id } = req.params
    const [products] = await pool.query(
      `
      SELECT 
        p.id, p.codigo, p.nombre, p.descripcion, p.marca, p.stock, p.stock_minimo,
        p.precio_costo, p.precio_venta, p.custom_pricing_config, p.tiene_codigo_barras as tieneCodigoBarras,
        p.fecha_ingreso as fechaIngreso, p.activo, p.categoria_id, p.proveedor_id,
        COALESCE(c.nombre, 'Sin Categoría') as categoria_nombre,
        COALESCE(pr.nombre, 'Sin Proveedor') as proveedor,
        COALESCE(
          (SELECT valor FROM configuracion WHERE clave = 'stock_minimo_default'), 
          p.stock_minimo, 
          5
        ) as stock_minimo_config
      FROM productos p
      LEFT JOIN categorias c ON p.categoria_id = c.id
      LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
      WHERE p.id = ?
    `,
      [id],
    )

    if (products.length === 0) {
      return res.status(404).json({ message: "Producto no encontrado" })
    }

    // Parsear configuración personalizada si existe
    const product = products[0]
    if (product.custom_pricing_config) {
      try {
        product.custom_pricing_config = JSON.parse(product.custom_pricing_config)
      } catch (error) {
        console.error("Error parsing custom pricing config:", error)
        product.custom_pricing_config = null
      }
    }

    res.status(200).json(product)
  } catch (error) {
    console.error("Error al obtener producto:", error)
    res.status(500).json({ message: "Error al obtener producto" })
  }
}

// Crear un nuevo producto
export const createProduct = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  try {
    const {
      codigo,
      nombre,
      descripcion,
      categoria,
      marca,
      stock = 0,
      precioCosto,
      proveedorId = 1,
      tieneCodigoBarras = false,
      customConfig = null, // Nueva propiedad para configuración personalizada
    } = req.body

    console.log("Creando producto con datos:", { codigo, nombre, precioCosto, customConfig })

    // Validar precio de costo
    if (!isValidPrice(precioCosto)) {
      return res.status(400).json({ message: "El precio de costo debe ser un número válido mayor o igual a 0" })
    }

    await ensureDefaults()

    const [existingProduct] = await pool.query("SELECT id FROM productos WHERE codigo = ?", [codigo])
    if (existingProduct.length > 0) {
      return res.status(400).json({ message: "El código del producto ya existe" })
    }

    // Determinar qué configuración usar para el cálculo
    let pricingConfig
    if (customConfig) {
      console.log("Usando configuración personalizada para el cálculo:", customConfig)
      pricingConfig = {
        rentabilidad: Number(customConfig.rentabilidad) || 40,
        iva: Number(customConfig.iva) || 21,
        ingresos_brutos: Number(customConfig.ingresos_brutos) || 0,
        otros_impuestos: Number(customConfig.otros_impuestos) || 0,
      }
    } else {
      console.log("Usando configuración global para el cálculo")
      pricingConfig = await getPricingConfig(pool)
    }

    const precioVenta = calculateSalePrice(precioCosto, pricingConfig)
    console.log("Precio calculado:", { precioCosto, precioVenta, pricingConfig })

    // Validar que el precio calculado sea válido
    if (!isValidPrice(precioVenta)) {
      console.error("Error calculando precio de venta:", { precioCosto, pricingConfig, precioVenta })
      return res
        .status(500)
        .json({ message: "Error al calcular el precio de venta. Verifique la configuración de precios." })
    }

    let categoriaId = 1
    if (categoria && categoria !== "Sin Categoría") {
      const [catResult] = await pool.query("SELECT id FROM categorias WHERE nombre = ?", [categoria])
      if (catResult.length > 0) categoriaId = catResult[0].id
    }

    // Preparar configuración personalizada para almacenar
    const customPricingConfig = customConfig ? JSON.stringify(customConfig) : null

    const [result] = await pool.query(
      `
      INSERT INTO productos (codigo, nombre, descripcion, categoria_id, marca, stock, precio_costo, precio_venta, custom_pricing_config, proveedor_id, tiene_codigo_barras, fecha_ingreso) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE())
    `,
      [
        codigo,
        nombre,
        descripcion,
        categoriaId,
        marca,
        stock,
        precioCosto,
        precioVenta,
        customPricingConfig,
        proveedorId,
        tieneCodigoBarras,
      ],
    )

    if (stock > 0) {
      await pool.query(
        `INSERT INTO movimientos_stock (producto_id, usuario_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo) VALUES (?, ?, 'entrada', ?, 0, ?, 'Stock inicial')`,
        [result.insertId, req.user.id, stock, stock],
      )
    }

    const breakdown = getPriceBreakdown(precioCosto, pricingConfig)
    res.status(201).json({
      message: "Producto creado exitosamente",
      id: result.insertId,
      precio_venta_calculado: precioVenta,
      desglose_calculo: breakdown,
      configuracion_usada: customConfig ? "personalizada" : "global",
    })
  } catch (error) {
    console.error("Error al crear producto:", error)
    res.status(500).json({ message: "Error al crear producto" })
  }
}

// Actualizar un producto
export const updateProduct = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  try {
    const { id } = req.params
    const {
      codigo,
      nombre,
      descripcion,
      categoria,
      marca,
      precioCosto,
      proveedorId,
      tieneCodigoBarras,
      customConfig = null, // Nueva propiedad para configuración personalizada
    } = req.body

    console.log("Actualizando producto con datos:", { id, codigo, nombre, precioCosto, customConfig })

    // Validar precio de costo
    if (!isValidPrice(precioCosto)) {
      return res.status(400).json({ message: "El precio de costo debe ser un número válido mayor o igual a 0" })
    }

    const [existingProduct] = await pool.query("SELECT id FROM productos WHERE id = ?", [id])
    if (existingProduct.length === 0) {
      return res.status(404).json({ message: "Producto no encontrado" })
    }

    const [codeCheck] = await pool.query("SELECT id FROM productos WHERE codigo = ? AND id != ?", [codigo, id])
    if (codeCheck.length > 0) {
      return res.status(400).json({ message: "El código del producto ya existe en otro producto" })
    }

    // Determinar qué configuración usar para el cálculo
    let pricingConfig
    if (customConfig) {
      console.log("Usando configuración personalizada para el cálculo:", customConfig)
      pricingConfig = {
        rentabilidad: Number(customConfig.rentabilidad) || 40,
        iva: Number(customConfig.iva) || 21,
        ingresos_brutos: Number(customConfig.ingresos_brutos) || 0,
        otros_impuestos: Number(customConfig.otros_impuestos) || 0,
      }
    } else {
      console.log("Usando configuración global para el cálculo")
      pricingConfig = await getPricingConfig(pool)
    }

    const precioVenta = calculateSalePrice(precioCosto, pricingConfig)
    console.log("Precio calculado:", { precioCosto, precioVenta, pricingConfig })

    // Validar que el precio calculado sea válido
    if (!isValidPrice(precioVenta)) {
      console.error("Error calculando precio de venta:", { precioCosto, pricingConfig, precioVenta })
      return res
        .status(500)
        .json({ message: "Error al calcular el precio de venta. Verifique la configuración de precios." })
    }

    let categoriaId = 1
    if (categoria && categoria !== "Sin Categoría") {
      const [catResult] = await pool.query("SELECT id FROM categorias WHERE nombre = ?", [categoria])
      if (catResult.length > 0) categoriaId = catResult[0].id
    }

    // Preparar configuración personalizada para almacenar
    const customPricingConfig = customConfig ? JSON.stringify(customConfig) : null

    await pool.query(
      `
      UPDATE productos SET codigo = ?, nombre = ?, descripcion = ?, categoria_id = ?, marca = ?, 
      precio_costo = ?, precio_venta = ?, custom_pricing_config = ?, proveedor_id = ?, tiene_codigo_barras = ?
      WHERE id = ?
    `,
      [
        codigo,
        nombre,
        descripcion,
        categoriaId,
        marca,
        precioCosto,
        precioVenta,
        customPricingConfig,
        proveedorId,
        tieneCodigoBarras,
        id,
      ],
    )

    const breakdown = getPriceBreakdown(precioCosto, pricingConfig)
    res.status(200).json({
      message: "Producto actualizado exitosamente",
      precio_venta_calculado: precioVenta,
      desglose_calculo: breakdown,
      configuracion_usada: customConfig ? "personalizada" : "global",
    })
  } catch (error) {
    console.error("Error al actualizar producto:", error)
    res.status(500).json({ message: "Error al actualizar producto" })
  }
}

// NUEVA FUNCIÓN: Actualizar solo los precios de un producto
export const updateProductPrices = async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  try {
    const { id } = req.params
    const { precio_costo, precio_venta, customConfig = null } = req.body

    console.log("Actualizando precios del producto:", { id, precio_costo, precio_venta, customConfig })

    // Validar que el producto existe
    const [existingProduct] = await pool.query(
      "SELECT id, nombre, codigo, custom_pricing_config FROM productos WHERE id = ?",
      [id],
    )
    if (existingProduct.length === 0) {
      return res.status(404).json({ message: "Producto no encontrado" })
    }

    // Validar precio de costo
    if (!isValidPrice(precio_costo)) {
      return res.status(400).json({ message: "El precio de costo debe ser un número válido mayor o igual a 0" })
    }

    let finalPrecioVenta = precio_venta

    // Si no se proporciona precio de venta, calcularlo automáticamente
    if (!finalPrecioVenta) {
      const pricingConfig = customConfig
        ? {
            rentabilidad: Number(customConfig.rentabilidad) || 40,
            iva: Number(customConfig.iva) || 21,
            ingresos_brutos: Number(customConfig.ingresos_brutos) || 0,
            otros_impuestos: Number(customConfig.otros_impuestos) || 0,
          }
        : await getPricingConfig(pool)

      finalPrecioVenta = calculateSalePrice(precio_costo, pricingConfig)
      console.log("Precio calculado automáticamente:", { precio_costo, finalPrecioVenta, pricingConfig })

      // Validar que el precio calculado sea válido
      if (!isValidPrice(finalPrecioVenta)) {
        console.error("Error calculando precio de venta automáticamente:", {
          precio_costo,
          pricingConfig,
          finalPrecioVenta,
        })
        return res.status(500).json({
          message: "Error al calcular el precio de venta automáticamente. Verifique la configuración de precios.",
        })
      }
    }

    await pool.query(
      `
      UPDATE productos SET precio_costo = ?, precio_venta = ?, custom_pricing_config = ?
      WHERE id = ?
    `,
      [precio_costo, finalPrecioVenta, customConfig ? JSON.stringify(customConfig) : null, id],
    )

    const breakdown = getPriceBreakdown(
      precio_costo,
      customConfig
        ? {
            rentabilidad: Number(customConfig.rentabilidad) || 40,
            iva: Number(customConfig.iva) || 21,
            ingresos_brutos: Number(customConfig.ingresos_brutos) || 0,
            otros_impuestos: Number(customConfig.otros_impuestos) || 0,
          }
        : await getPricingConfig(pool),
    )
    res.status(200).json({
      message: "Precios del producto actualizados exitosamente",
      precio_venta_calculado: finalPrecioVenta,
      desglose_calculo: breakdown,
      configuracion_usada: customConfig ? "personalizada" : "global",
    })
  } catch (error) {
    console.error("Error al actualizar precios del producto:", error)
    res.status(500).json({ message: "Error al actualizar precios del producto" })
  }
}

// Eliminar un producto
export const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params

    // Validar que el producto existe
    const [existingProduct] = await pool.query("SELECT id, nombre, codigo FROM productos WHERE id = ?", [id])
    if (existingProduct.length === 0) {
      return res.status(404).json({ message: "Producto no encontrado" })
    }

    const product = existingProduct[0]

    // Verificar si el producto tiene movimientos de stock o está en ventas
    const [stockMovements] = await pool.query("SELECT COUNT(*) as count FROM movimientos_stock WHERE producto_id = ?", [
      id,
    ])
    const [salesItems] = await pool.query("SELECT COUNT(*) as count FROM detalle_ventas WHERE producto_id = ?", [id])

    if (stockMovements[0].count > 0 || salesItems[0].count > 0) {
      // Si tiene movimientos o ventas, marcar como inactivo en lugar de eliminar
      await pool.query("UPDATE productos SET activo = FALSE WHERE id = ?", [id])

      res.status(200).json({
        message: `Producto "${product.nombre}" desactivado exitosamente. No se puede eliminar porque tiene historial de movimientos o ventas.`,
        action: "deactivated",
      })
    } else {
      // Si no tiene historial, eliminar completamente
      await pool.query("DELETE FROM productos WHERE id = ?", [id])

      res.status(200).json({
        message: `Producto "${product.nombre}" eliminado exitosamente`,
        action: "deleted",
      })
    }
  } catch (error) {
    console.error("Error al eliminar producto:", error)
    res.status(500).json({ message: "Error al eliminar producto" })
  }
}

// Validar código único de producto
export const validateProductCode = async (req, res) => {
  try {
    const { code, excludeId = null } = req.body

    if (!code || code.trim() === "") {
      return res.status(400).json({ message: "El código es requerido" })
    }

    let query = "SELECT id FROM productos WHERE codigo = ?"
    const params = [code.trim()]

    if (excludeId) {
      query += " AND id != ?"
      params.push(excludeId)
    }

    const [existingProduct] = await pool.query(query, params)
    const isUnique = existingProduct.length === 0

    res.status(200).json({
      isUnique,
      message: isUnique ? "Código disponible" : "El código ya existe",
    })
  } catch (error) {
    console.error("Error al validar código:", error)
    res.status(500).json({ message: "Error al validar código" })
  }
}

// Obtener desglose de precios de un producto
export const getProductPriceBreakdown = async (req, res) => {
  try {
    const { id } = req.params

    const [products] = await pool.query("SELECT precio_costo, custom_pricing_config FROM productos WHERE id = ?", [id])

    if (products.length === 0) {
      return res.status(404).json({ message: "Producto no encontrado" })
    }

    const product = products[0]

    // Obtener configuración de precios para este producto
    const pricingConfig = await getProductPricingConfig(product, pool)

    // Generar desglose
    const breakdown = getPriceBreakdown(product.precio_costo, pricingConfig)

    res.status(200).json({
      breakdown,
      config: pricingConfig,
    })
  } catch (error) {
    console.error("Error al obtener desglose de precios:", error)
    res.status(500).json({ message: "Error al obtener desglose de precios" })
  }
}

// Mejorar la función searchProducts para que sea más eficiente y progresiva:

// Búsqueda de productos (para modales y búsquedas rápidas) - MEJORADA
export const searchProducts = async (req, res) => {
  try {
    const { search = "", limit = 50 } = req.query

    if (!search || search.trim().length < 1) {
      return res.status(200).json({
        success: true,
        data: [],
        message: "Término de búsqueda requerido",
      })
    }

    const searchTerm = search.trim()
    const searchPattern = `%${searchTerm}%`

    // Query optimizada con relevancia
    const [products] = await pool.query(
      `
      SELECT 
        p.id, p.codigo, p.nombre, p.descripcion, p.marca, p.stock, p.stock_minimo,
        p.precio_costo, p.precio_venta, p.custom_pricing_config, p.tiene_codigo_barras as tieneCodigoBarras,
        p.fecha_ingreso as fechaIngreso, p.activo, p.categoria_id, p.proveedor_id,
        COALESCE(c.nombre, 'Sin Categoría') as categoria_nombre,
        COALESCE(pr.nombre, 'Sin Proveedor') as proveedor,
        -- Calcular relevancia para ordenamiento
        CASE 
          WHEN p.codigo = ? THEN 100
          WHEN p.codigo LIKE CONCAT(?, '%') THEN 90
          WHEN p.codigo LIKE ? THEN 80
          WHEN p.nombre = ? THEN 70
          WHEN p.nombre LIKE CONCAT(?, '%') THEN 60
          WHEN p.nombre LIKE ? THEN 50
          WHEN p.descripcion LIKE CONCAT(?, '%') THEN 40
          WHEN p.descripcion LIKE ? THEN 30
          WHEN p.marca LIKE CONCAT(?, '%') THEN 20
          WHEN p.marca LIKE ? THEN 10
          ELSE 0
        END as relevancia
      FROM productos p
      LEFT JOIN categorias c ON p.categoria_id = c.id
      LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
      WHERE p.activo = TRUE 
      AND (
        p.codigo LIKE ? OR 
        p.nombre LIKE ? OR 
        p.descripcion LIKE ? OR 
        p.marca LIKE ?
      )
      ORDER BY relevancia DESC, p.nombre ASC
      LIMIT ?
    `,
      [
        // Para cálculo de relevancia
        searchTerm,
        searchTerm,
        searchPattern, // código
        searchTerm,
        searchTerm,
        searchPattern, // nombre
        searchTerm,
        searchPattern, // descripción
        searchTerm,
        searchPattern, // marca
        // Para filtrado
        searchPattern,
        searchPattern,
        searchPattern,
        searchPattern,
        // Límite
        Number.parseInt(limit),
      ],
    )

    // Parsear configuración personalizada para cada producto
    products.forEach((product) => {
      if (product.custom_pricing_config) {
        try {
          product.custom_pricing_config = JSON.parse(product.custom_pricing_config)
        } catch (error) {
          console.error("Error parsing custom pricing config for product", product.id, error)
          product.custom_pricing_config = null
        }
      }
      // Remover el campo de relevancia del resultado final
      delete product.relevancia
    })

    res.status(200).json({
      success: true,
      data: products,
      searchTerm: searchTerm,
      totalResults: products.length,
    })
  } catch (error) {
    console.error("Error en búsqueda de productos:", error)
    res.status(500).json({
      success: false,
      message: "Error en la búsqueda de productos",
    })
  }
}
