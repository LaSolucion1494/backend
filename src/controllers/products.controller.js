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

// Buscar producto por código
export const getProductByCode = async (req, res) => {
  try {
    const { code } = req.params

    const [products] = await pool.query(
      `
      SELECT 
        p.id, p.codigo, p.nombre, p.descripcion, p.marca, p.stock, p.stock_minimo,
        p.precio_costo, p.precio_venta, p.tiene_codigo_barras as tieneCodigoBarras,
        p.fecha_ingreso as fechaIngreso, p.activo, p.categoria_id, p.proveedor_id,
        COALESCE(c.nombre, 'Sin Categoría') as categoria,
        COALESCE(pr.nombre, 'Sin Proveedor') as proveedor
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

    res.status(200).json(products[0])
  } catch (error) {
    console.error("Error al buscar producto por código:", error)
    res.status(500).json({ message: "Error al buscar producto por código" })
  }
}

// Obtener todos los productos con filtros
export const getProducts = async (req, res) => {
  try {
    const {
      search = "",
      categoria = "",
      stockStatus = "todos",
      activo = "true", // Por defecto, solo activos
      minPrice = "",
      maxPrice = "",
      sortBy = "nombre",
      sortOrder = "asc",
    } = req.query

    let query = `
      SELECT 
        p.id, p.codigo, p.nombre, p.descripcion, p.marca, p.stock, p.stock_minimo,
        p.precio_costo, p.precio_venta, p.tiene_codigo_barras as tieneCodigoBarras,
        p.fecha_ingreso as fechaIngreso, p.activo, p.proveedor_id,
        COALESCE(c.nombre, 'Sin Categoría') as categoria,
        COALESCE(pr.nombre, 'Sin Proveedor') as proveedor
      FROM productos p
      LEFT JOIN categorias c ON p.categoria_id = c.id
      LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
      WHERE 1=1
    `
    const queryParams = []

    if (activo === "true") query += ` AND p.activo = TRUE`
    else if (activo === "false") query += ` AND p.activo = FALSE`

    if (search) {
      query += ` AND (p.codigo LIKE ? OR p.nombre LIKE ? OR p.descripcion LIKE ? OR p.marca LIKE ?)`
      const searchTerm = `%${search}%`
      queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm)
    }

    if (categoria && categoria !== "Todos") {
      query += ` AND c.nombre = ?`
      queryParams.push(categoria)
    }

    if (stockStatus === "disponible") query += ` AND p.stock > 0`
    else if (stockStatus === "bajo") query += ` AND p.stock <= p.stock_minimo AND p.stock > 0`
    else if (stockStatus === "agotado") query += ` AND p.stock = 0`

    if (minPrice) {
      query += ` AND p.precio_venta >= ?`
      queryParams.push(Number.parseFloat(minPrice))
    }
    if (maxPrice) {
      query += ` AND p.precio_venta <= ?`
      queryParams.push(Number.parseFloat(maxPrice))
    }

    const validSortFields = ["nombre", "codigo", "stock", "precio_costo", "precio_venta", "categoria", "marca"]
    if (validSortFields.includes(sortBy)) {
      query += ` ORDER BY ${sortBy === "categoria" ? "c.nombre" : `p.${sortBy}`} ${sortOrder === "desc" ? "DESC" : "ASC"}`
    }

    const [products] = await pool.query(query, queryParams)
    res.status(200).json(products)
  } catch (error) {
    console.error("Error al obtener productos:", error)
    res.status(500).json({ message: "Error al obtener productos" })
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
        p.precio_costo, p.precio_venta, p.tiene_codigo_barras as tieneCodigoBarras,
        p.fecha_ingreso as fechaIngreso, p.activo, p.categoria_id, p.proveedor_id,
        COALESCE(c.nombre, 'Sin Categoría') as categoria,
        COALESCE(pr.nombre, 'Sin Proveedor') as proveedor
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
    res.status(200).json(products[0])
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
    } = req.body

    // Validar precio de costo
    if (!isValidPrice(precioCosto)) {
      return res.status(400).json({ message: "El precio de costo debe ser un número válido mayor o igual a 0" })
    }

    await ensureDefaults()

    const [existingProduct] = await pool.query("SELECT id FROM productos WHERE codigo = ?", [codigo])
    if (existingProduct.length > 0) {
      return res.status(400).json({ message: "El código del producto ya existe" })
    }

    // Usar la lógica centralizada de precios
    const pricingConfig = await getPricingConfig(pool)
    const precioVenta = calculateSalePrice(precioCosto, pricingConfig)

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

    const [result] = await pool.query(
      `
      INSERT INTO productos (codigo, nombre, descripcion, categoria_id, marca, stock, precio_costo, precio_venta, proveedor_id, tiene_codigo_barras, fecha_ingreso) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE())
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
    const { codigo, nombre, descripcion, categoria, marca, precioCosto, proveedorId, tieneCodigoBarras } = req.body

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

    // Usar la lógica centralizada de precios
    const pricingConfig = await getPricingConfig(pool)
    const precioVenta = calculateSalePrice(precioCosto, pricingConfig)

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

    await pool.query(
      `
      UPDATE productos SET codigo = ?, nombre = ?, descripcion = ?, categoria_id = ?, marca = ?, 
      precio_costo = ?, precio_venta = ?, proveedor_id = ?, tiene_codigo_barras = ?
      WHERE id = ?
    `,
      [codigo, nombre, descripcion, categoriaId, marca, precioCosto, precioVenta, proveedorId, tieneCodigoBarras, id],
    )

    const breakdown = getPriceBreakdown(precioCosto, pricingConfig)
    res.status(200).json({
      message: "Producto actualizado exitosamente",
      precio_venta_calculado: precioVenta,
      desglose_calculo: breakdown,
    })
  } catch (error) {
    console.error("Error al actualizar producto:", error)
    res.status(500).json({ message: "Error al actualizar producto" })
  }
}

// Eliminar un producto (eliminación lógica o permanente)
export const deleteProduct = async (req, res) => {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const { id } = req.params

    // Eliminar movimientos de stock asociados
    await connection.query("DELETE FROM movimientos_stock WHERE producto_id = ?", [id])
    // Eliminar el producto
    const [result] = await connection.query("DELETE FROM productos WHERE id = ?", [id])

    if (result.affectedRows === 0) {
      await connection.rollback()
      return res.status(404).json({ message: "Producto no encontrado" })
    }

    await connection.commit()
    res.status(200).json({ message: "Producto eliminado permanentemente" })
  } catch (error) {
    await connection.rollback()
    console.error("Error al eliminar producto:", error)
    res.status(500).json({ message: "Error al eliminar producto" })
  } finally {
    connection.release()
  }
}

// Validar si un código de producto es único
export const validateProductCode = async (req, res) => {
  try {
    const { code, excludeId = null } = req.body
    if (!code) {
      return res.status(400).json({ message: "El código es requerido" })
    }

    let query = "SELECT id FROM productos WHERE codigo = ?"
    const params = [code]
    if (excludeId) {
      query += " AND id != ?"
      params.push(excludeId)
    }

    const [existing] = await pool.query(query, params)
    res.status(200).json({ isUnique: existing.length === 0 })
  } catch (error) {
    console.error("Error al validar código de producto:", error)
    res.status(500).json({ message: "Error al validar código de producto" })
  }
}

// Obtener desglose de cálculo de un producto específico
export const getProductPriceBreakdown = async (req, res) => {
  try {
    const { id } = req.params
    const [products] = await pool.query("SELECT precio_costo FROM productos WHERE id = ?", [id])

    if (products.length === 0) {
      return res.status(404).json({ message: "Producto no encontrado" })
    }

    // Validar precio de costo
    if (!isValidPrice(products[0].precio_costo)) {
      return res.status(400).json({ message: "El producto tiene un precio de costo inválido" })
    }

    // Usar la lógica centralizada de precios
    const pricingConfig = await getPricingConfig(pool)
    const breakdown = getPriceBreakdown(products[0].precio_costo, pricingConfig)

    res.status(200).json({
      message: "Desglose de cálculo obtenido exitosamente",
      desglose: breakdown,
    })
  } catch (error) {
    console.error("Error al obtener desglose de precios:", error)
    res.status(500).json({ message: "Error al obtener desglose de precios" })
  }
}
