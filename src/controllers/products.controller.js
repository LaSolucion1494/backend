import pool from "../db.js"
import { validationResult } from "express-validator"

// Función para obtener la configuración de precios
const getPricingConfig = async (connection) => {
  try {
    const [config] = await connection.query(`
      SELECT clave, valor, tipo FROM configuracion 
      WHERE clave IN ('rentabilidad', 'iva', 'ingresos_brutos')
    `)

    const configObj = {
      rentabilidad: 40, // Valores por defecto
      iva: 21,
      ingresos_brutos: 0,
    }

    config.forEach((item) => {
      if (item.tipo === "numero") {
        configObj[item.clave] = Number.parseFloat(item.valor)
      } else {
        configObj[item.clave] = item.valor
      }
    })

    return configObj
  } catch (error) {
    console.error("Error al obtener configuración de precios:", error)
    // Devolver valores por defecto en caso de error
    return {
      rentabilidad: 40,
      iva: 21,
      ingresos_brutos: 0,
    }
  }
}

// Función para calcular precio de venta
const calculateSalePrice = (costPrice, config) => {
  const { rentabilidad, iva, ingresos_brutos } = config
  const basePrice = costPrice * (1 + rentabilidad / 100)
  const withIva = basePrice * (1 + iva / 100)
  const finalPrice = withIva * (1 + ingresos_brutos / 100)
  return Math.round(finalPrice * 100) / 100 // Redondear a 2 decimales
}

// Función para asegurar que existen los valores por defecto
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

// Buscar producto por código
export const getProductByCode = async (req, res) => {
  try {
    const { code } = req.params

    const [products] = await pool.query(
      `
      SELECT 
        p.id,
        p.codigo,
        p.nombre,
        p.descripcion,
        p.marca,
        p.stock,
        p.stock_minimo,
        p.precio_costo as precioCosto,
        p.tiene_codigo_barras as tieneCodigoBarras,
        p.fecha_ingreso as fechaIngreso,
        p.activo,
        p.categoria_id,
        p.proveedor_id,
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
      return res.status(404).json({ message: "Producto no encontrado con este código" })
    }

    // Obtener configuración de precios
    const pricingConfig = await getPricingConfig(pool)

    // Calcular precio de venta
    const product = products[0]
    product.precio_venta = calculateSalePrice(product.precioCosto, pricingConfig)

    res.status(200).json(product)
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
      activo = "",
      conStock = "",
      minPrice = "",
      maxPrice = "",
      sortBy = "nombre",
      sortOrder = "asc",
    } = req.query

    let query = `
      SELECT 
        p.id,
        p.codigo,
        p.nombre,
        p.descripcion,
        p.marca,
        p.stock,
        p.stock_minimo,
        p.precio_costo as precioCosto,
        p.tiene_codigo_barras as tieneCodigoBarras,
        p.fecha_ingreso as fechaIngreso,
        p.activo,
        p.proveedor_id,
        COALESCE(c.nombre, 'Sin Categoría') as categoria,
        COALESCE(pr.nombre, 'Sin Proveedor') as proveedor,
        COALESCE(p.marca, 'Sin Marca') as marca,
        COALESCE(p.descripcion, 'Sin Descripción') as descripcion
      FROM productos p
      LEFT JOIN categorias c ON p.categoria_id = c.id
      LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
      WHERE 1=1
    `

    const queryParams = []

    // Filtro de activo
    if (activo === "true") {
      query += ` AND p.activo = TRUE`
    } else if (activo === "false") {
      query += ` AND p.activo = FALSE`
    }

    // Filtro de stock
    if (conStock === "true") {
      query += ` AND p.stock > 0`
    }

    // Filtro de búsqueda
    if (search) {
      query += ` AND (
        p.codigo LIKE ? OR 
        p.nombre LIKE ? OR 
        COALESCE(p.descripcion, 'Sin Descripción') LIKE ? OR 
        COALESCE(p.marca, 'Sin Marca') LIKE ?
      )`
      const searchTerm = `%${search}%`
      queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm)
    }

    // Filtro por categoría
    if (categoria && categoria !== "Todos") {
      query += ` AND COALESCE(c.nombre, 'Sin Categoría') = ?`
      queryParams.push(categoria)
    }

    // Filtro por estado de stock
    switch (stockStatus) {
      case "disponible":
        query += ` AND p.stock > 0`
        break
      case "bajo":
        query += ` AND p.stock <= p.stock_minimo AND p.stock > 0`
        break
      case "agotado":
        query += ` AND p.stock = 0`
        break
    }

    // Filtro por rango de precios
    if (minPrice) {
      query += ` AND p.precio_costo >= ?`
      queryParams.push(Number.parseFloat(minPrice))
    }
    if (maxPrice) {
      query += ` AND p.precio_costo <= ?`
      queryParams.push(Number.parseFloat(maxPrice))
    }

    // Ordenamiento
    const validSortFields = ["nombre", "codigo", "stock", "precio_costo", "categoria", "marca"]
    const validSortOrders = ["asc", "desc"]

    if (validSortFields.includes(sortBy) && validSortOrders.includes(sortOrder)) {
      if (sortBy === "categoria") {
        query += ` ORDER BY COALESCE(c.nombre, 'Sin Categoría') ${sortOrder}`
      } else if (sortBy === "precio_costo") {
        query += ` ORDER BY p.precio_costo ${sortOrder}`
      } else if (sortBy === "marca") {
        query += ` ORDER BY COALESCE(p.marca, 'Sin Marca') ${sortOrder}`
      } else {
        query += ` ORDER BY p.${sortBy} ${sortOrder}`
      }
    }

    // Ejecutar consulta
    const [products] = await pool.query(query, queryParams)

    // Obtener configuración de precios
    const pricingConfig = await getPricingConfig(pool)

    // Calcular precio de venta y convertir fechas a ISO antes de enviar
    const productsWithCalculations = products.map((p) => ({
      ...p,
      precio_venta: calculateSalePrice(p.precioCosto, pricingConfig),
      fechaIngreso: p.fechaIngreso.toISOString(),
    }))

    res.status(200).json(productsWithCalculations)
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
        p.id,
        p.codigo,
        p.nombre,
        p.descripcion,
        p.marca,
        p.stock,
        p.stock_minimo,
        p.precio_costo as precioCosto,
        p.tiene_codigo_barras as tieneCodigoBarras,
        p.fecha_ingreso as fechaIngreso,
        p.activo,
        p.categoria_id,
        p.proveedor_id,
        COALESCE(c.nombre, 'Sin Categoría') as categoria,
        COALESCE(pr.nombre, 'Sin Proveedor') as proveedor
      FROM productos p
      LEFT JOIN categorias c ON p.categoria_id = c.id
      LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
      WHERE p.id = ? AND p.activo = TRUE
    `,
      [id],
    )

    if (products.length === 0) {
      return res.status(404).json({ message: "Producto no encontrado" })
    }

    // Obtener configuración de precios
    const pricingConfig = await getPricingConfig(pool)

    // Calcular precio de venta
    const product = products[0]
    product.precio_venta = calculateSalePrice(product.precioCosto, pricingConfig)

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
      descripcion = null,
      categoria = "Sin Categoría",
      marca = null,
      stock = 0,
      precioCosto,
      proveedorId = 1,
      tieneCodigoBarras = false,
    } = req.body

    // Asegurar que existen los valores por defecto
    await ensureDefaults()

    // Verificar si el código ya existe
    const [existingProduct] = await pool.query("SELECT id FROM productos WHERE codigo = ?", [codigo])

    if (existingProduct.length > 0) {
      return res.status(400).json({ message: "El código del producto ya existe" })
    }

    // Obtener ID de categoría
    let categoriaId = 1 // Por defecto "Sin Categoría"
    if (categoria && categoria !== "Sin Categoría") {
      const [categoriaResult] = await pool.query("SELECT id FROM categorias WHERE nombre = ?", [categoria])
      if (categoriaResult.length > 0) {
        categoriaId = categoriaResult[0].id
      }
    }

    // Validar que el proveedor existe
    const [proveedorResult] = await pool.query("SELECT id FROM proveedores WHERE id = ? AND activo = TRUE", [
      proveedorId,
    ])
    if (proveedorResult.length === 0) {
      return res.status(400).json({ message: "El proveedor seleccionado no existe" })
    }

    // Preparar valores para inserción
    const marcaValue = marca && marca.trim() ? marca : null
    const descripcionValue = descripcion && descripcion.trim() ? descripcion : null

    // Insertar producto (sin la columna codigo_barras)
    const [result] = await pool.query(
      `
      INSERT INTO productos (
        codigo, nombre, descripcion, categoria_id, marca, 
        stock, precio_costo, proveedor_id, tiene_codigo_barras, fecha_ingreso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE())
    `,
      [codigo, nombre, descripcionValue, categoriaId, marcaValue, stock, precioCosto, proveedorId, tieneCodigoBarras],
    )

    // Si hay stock inicial, crear movimiento
    if (stock > 0) {
      await pool.query(
        `
        INSERT INTO movimientos_stock (
          producto_id, usuario_id, tipo, cantidad, 
          stock_anterior, stock_nuevo, motivo
        ) VALUES (?, ?, 'entrada', ?, 0, ?, 'Stock inicial')
      `,
        [result.insertId, req.user.id, stock, stock],
      )
    }

    res.status(201).json({
      message: "Producto creado exitosamente",
      id: result.insertId,
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
      descripcion = null,
      categoria = "Sin Categoría",
      marca = null,
      precioCosto,
      proveedorId = 1,
      tieneCodigoBarras = false,
    } = req.body

    // Verificar si el producto existe
    const [existingProduct] = await pool.query("SELECT id FROM productos WHERE id = ? AND activo = TRUE", [id])

    if (existingProduct.length === 0) {
      return res.status(404).json({ message: "Producto no encontrado" })
    }

    // Verificar si el código ya existe en otro producto
    const [codeCheck] = await pool.query("SELECT id FROM productos WHERE codigo = ? AND id != ?", [codigo, id])

    if (codeCheck.length > 0) {
      return res.status(400).json({ message: "El código del producto ya existe" })
    }

    // Obtener ID de categoría
    let categoriaId = 1 // Por defecto "Sin Categoría"
    if (categoria && categoria !== "Sin Categoría") {
      const [categoriaResult] = await pool.query("SELECT id FROM categorias WHERE nombre = ?", [categoria])
      if (categoriaResult.length > 0) {
        categoriaId = categoriaResult[0].id
      }
    }

    // Validar que el proveedor existe
    const [proveedorResult] = await pool.query("SELECT id FROM proveedores WHERE id = ? AND activo = TRUE", [
      proveedorId,
    ])
    if (proveedorResult.length === 0) {
      return res.status(400).json({ message: "El proveedor seleccionado no existe" })
    }

    // Preparar valores para actualización
    const marcaValue = marca ? marca.trim() : null
    const descripcionValue = descripcion && descripcion.trim() ? descripcion : null

    // Actualizar producto (sin la columna codigo_barras)
    await pool.query(
      `
      UPDATE productos SET 
        codigo = ?, nombre = ?, descripcion = ?, categoria_id = ?, 
        marca = ?, precio_costo = ?, proveedor_id = ?, tiene_codigo_barras = ?
      WHERE id = ?
    `,
      [codigo, nombre, descripcionValue, categoriaId, marcaValue, precioCosto, proveedorId, tieneCodigoBarras, id],
    )

    res.status(200).json({ message: "Producto actualizado exitosamente" })
  } catch (error) {
    console.error("Error al actualizar producto:", error)
    res.status(500).json({ message: "Error al actualizar producto" })
  }
}

// Eliminar un producto (eliminación permanente)
export const deleteProduct = async (req, res) => {
  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    const { id } = req.params

    // Verificar si el producto existe
    const [existingProduct] = await connection.query("SELECT id FROM productos WHERE id = ?", [id])

    if (existingProduct.length === 0) {
      await connection.rollback()
      return res.status(404).json({ message: "Producto no encontrado" })
    }

    // Eliminar primero los movimientos de stock asociados
    await connection.query("DELETE FROM movimientos_stock WHERE producto_id = ?", [id])

    // Eliminar el producto permanentemente
    await connection.query("DELETE FROM productos WHERE id = ?", [id])

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

    let query = "SELECT id FROM productos WHERE codigo = ? AND activo = TRUE"
    const params = [code]

    // Si se proporciona excludeId, excluir ese producto de la validación
    if (excludeId) {
      query += " AND id != ?"
      params.push(excludeId)
    }

    const [existingProducts] = await pool.query(query, params)

    res.status(200).json({
      isUnique: existingProducts.length === 0,
      exists: existingProducts.length > 0,
    })
  } catch (error) {
    console.error("Error al validar código de producto:", error)
    res.status(500).json({ message: "Error al validar código de producto" })
  }
}
