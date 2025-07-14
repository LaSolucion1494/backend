import pool from "../db.js"

// Obtener datos completos del dashboard
export const getDashboardData = async (req, res) => {
  try {
    console.log("getDashboardData called")

    // Obtener estadísticas principales
    const stats = await getDashboardStatsFunction()

    // Obtener ventas recientes (últimas 10)
    const recentSales = await getRecentSales()

    // Obtener productos con stock bajo (últimos 15)
    const lowStockProducts = await getLowStockProducts()

    const dashboardData = {
      stats,
      recentSales,
      lowStockProducts,
    }

    console.log("Dashboard data compiled successfully")
    res.status(200).json({
      success: true,
      data: dashboardData,
    })
  } catch (error) {
    console.error("Error al obtener datos del dashboard:", error)
    res.status(500).json({
      success: false,
      message: "Error al obtener datos del dashboard",
      error: error.message,
    })
  }
}

// Función auxiliar para obtener estadísticas principales
const getDashboardStatsFunction = async () => {
  try {
    const today = new Date().toISOString().split("T")[0]

    // Consulta optimizada para obtener todas las estadísticas en una sola query
    const [statsResult] = await pool.query(
      `
      SELECT 
        -- Ventas del día
        (SELECT COUNT(*) FROM ventas WHERE DATE(fecha_venta) = ? AND estado = 'completada') as ventasHoy,
        (SELECT COALESCE(SUM(total), 0) FROM ventas WHERE DATE(fecha_venta) = ? AND estado = 'completada') as montoVentasHoy,
        
        -- Estadísticas generales
        (SELECT COUNT(*) FROM productos WHERE activo = TRUE) as totalProductos,
        (SELECT COUNT(*) FROM productos WHERE activo = TRUE AND stock <= stock_minimo) as productosStockBajo,
        (SELECT COUNT(*) FROM clientes WHERE activo = TRUE) as clientesActivos,
        
        -- Estadísticas adicionales
        (SELECT COUNT(*) FROM productos WHERE activo = TRUE AND stock = 0) as productosSinStock,
        (SELECT COUNT(*) FROM ventas WHERE DATE(fecha_venta) = ? AND estado = 'completada') as ventasCompletadasHoy,
        (SELECT COUNT(*) FROM ventas WHERE DATE(fecha_venta) = ? AND estado = 'anulada') as ventasAnuladasHoy
    `,
      [today, today, today, today],
    )

    return (
      statsResult[0] || {
        ventasHoy: 0,
        montoVentasHoy: 0,
        totalProductos: 0,
        productosStockBajo: 0,
        clientesActivos: 0,
        productosSinStock: 0,
        ventasCompletadasHoy: 0,
        ventasAnuladasHoy: 0,
      }
    )
  } catch (error) {
    console.error("Error al obtener estadísticas del dashboard:", error)
    throw error
  }
}

// Función auxiliar para obtener ventas recientes
const getRecentSales = async () => {
  try {
    const [recentSales] = await pool.query(`
      SELECT 
        v.id,
        v.numero_factura,
        v.fecha_venta,
        v.fecha_creacion,
        v.total,
        v.estado,
        v.observaciones,
        c.nombre as cliente_nombre
      FROM ventas v
      LEFT JOIN clientes c ON v.cliente_id = c.id
      WHERE v.estado = 'completada'
      ORDER BY v.fecha_creacion DESC
      LIMIT 10
    `)

    return recentSales.map((sale) => ({
      ...sale,
      fecha_venta: sale.fecha_venta.toISOString().split("T")[0],
      fecha_creacion: sale.fecha_creacion.toISOString(),
    }))
  } catch (error) {
    console.error("Error al obtener ventas recientes:", error)
    throw error
  }
}

// Función auxiliar para obtener productos con stock bajo
const getLowStockProducts = async () => {
  try {
    const [lowStockProducts] = await pool.query(`
      SELECT 
        p.id,
        p.codigo,
        p.nombre,
        p.descripcion,
        p.marca,
        p.stock,
        p.stock_minimo,
        p.precio_costo,
        p.precio_venta,
        COALESCE(c.nombre, 'Sin Categoría') as categoria_nombre,
        COALESCE(pr.nombre, 'Sin Proveedor') as proveedor_nombre
      FROM productos p
      LEFT JOIN categorias c ON p.categoria_id = c.id
      LEFT JOIN proveedores pr ON p.proveedor_id = pr.id
      WHERE p.activo = TRUE 
      AND p.stock <= p.stock_minimo
      ORDER BY p.stock ASC, p.nombre ASC
      LIMIT 15
    `)

    return lowStockProducts
  } catch (error) {
    console.error("Error al obtener productos con stock bajo:", error)
    throw error
  }
}

// Obtener solo estadísticas (endpoint separado para actualizaciones rápidas)
export const getDashboardStats = async (req, res) => {
  try {
    const stats = await getDashboardStatsFunction()

    res.status(200).json({
      success: true,
      data: stats,
    })
  } catch (error) {
    console.error("Error al obtener estadísticas:", error)
    res.status(500).json({
      success: false,
      message: "Error al obtener estadísticas",
      error: error.message,
    })
  }
}

// Obtener resumen rápido para widgets
export const getQuickSummary = async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0]
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split("T")[0]

    const [summary] = await pool.query(
      `
      SELECT 
        -- Hoy
        (SELECT COUNT(*) FROM ventas WHERE DATE(fecha_venta) = ? AND estado = 'completada') as ventasHoy,
        (SELECT COALESCE(SUM(total), 0) FROM ventas WHERE DATE(fecha_venta) = ? AND estado = 'completada') as montoHoy,
        
        -- Ayer
        (SELECT COUNT(*) FROM ventas WHERE DATE(fecha_venta) = ? AND estado = 'completada') as ventasAyer,
        (SELECT COALESCE(SUM(total), 0) FROM ventas WHERE DATE(fecha_venta) = ? AND estado = 'completada') as montoAyer,
        
        -- Esta semana
        (SELECT COUNT(*) FROM ventas WHERE fecha_venta >= DATE_SUB(?, INTERVAL 7 DAY) AND estado = 'completada') as ventasSemana,
        (SELECT COALESCE(SUM(total), 0) FROM ventas WHERE fecha_venta >= DATE_SUB(?, INTERVAL 7 DAY) AND estado = 'completada') as montoSemana,
        
        -- Este mes
        (SELECT COUNT(*) FROM ventas WHERE MONTH(fecha_venta) = MONTH(?) AND YEAR(fecha_venta) = YEAR(?) AND estado = 'completada') as ventasMes,
        (SELECT COALESCE(SUM(total), 0) FROM ventas WHERE MONTH(fecha_venta) = MONTH(?) AND YEAR(fecha_venta) = YEAR(?) AND estado = 'completada') as montoMes
    `,
      [today, today, yesterday, yesterday, today, today, today, today, today, today],
    )

    const result = summary[0] || {}

    // Calcular porcentajes de crecimiento
    const crecimientoVentas =
      result.ventasAyer > 0 ? (((result.ventasHoy - result.ventasAyer) / result.ventasAyer) * 100).toFixed(1) : 0

    const crecimientoMonto =
      result.montoAyer > 0 ? (((result.montoHoy - result.montoAyer) / result.montoAyer) * 100).toFixed(1) : 0

    res.status(200).json({
      success: true,
      data: {
        ...result,
        crecimientoVentas: Number.parseFloat(crecimientoVentas),
        crecimientoMonto: Number.parseFloat(crecimientoMonto),
      },
    })
  } catch (error) {
    console.error("Error al obtener resumen rápido:", error)
    res.status(500).json({
      success: false,
      message: "Error al obtener resumen rápido",
      error: error.message,
    })
  }
}

// Obtener productos más vendidos
export const getTopProducts = async (req, res) => {
  try {
    const { days = 30, limit = 10 } = req.query

    const [topProducts] = await pool.query(
      `
      SELECT 
        p.id,
        p.codigo,
        p.nombre,
        p.marca,
        p.precio_venta,
        COALESCE(c.nombre, 'Sin Categoría') as categoria_nombre,
        SUM(dv.cantidad) as cantidad_vendida,
        SUM(dv.subtotal) as total_vendido,
        COUNT(DISTINCT v.id) as numero_ventas
      FROM detalles_ventas dv
      JOIN ventas v ON dv.venta_id = v.id
      JOIN productos p ON dv.producto_id = p.id
      LEFT JOIN categorias c ON p.categoria_id = c.id
      WHERE v.fecha_venta >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      AND v.estado = 'completada'
      GROUP BY p.id
      ORDER BY cantidad_vendida DESC
      LIMIT ?
    `,
      [Number.parseInt(days), Number.parseInt(limit)],
    )

    res.status(200).json({
      success: true,
      data: topProducts,
    })
  } catch (error) {
    console.error("Error al obtener productos más vendidos:", error)
    res.status(500).json({
      success: false,
      message: "Error al obtener productos más vendidos",
      error: error.message,
    })
  }
}

// Obtener alertas del sistema
export const getSystemAlerts = async (req, res) => {
  try {
    const alerts = []

    // Productos sin stock
    const [outOfStock] = await pool.query(`
      SELECT COUNT(*) as count FROM productos 
      WHERE activo = TRUE AND stock = 0
    `)

    if (outOfStock[0].count > 0) {
      alerts.push({
        type: "warning",
        title: "Productos sin stock",
        message: `${outOfStock[0].count} productos sin stock disponible`,
        action: "Ver productos",
        actionUrl: "/stock?stockStatus=agotado",
      })
    }

    // Productos con stock bajo
    const [lowStock] = await pool.query(`
      SELECT COUNT(*) as count FROM productos 
      WHERE activo = TRUE AND stock > 0 AND stock <= stock_minimo
    `)

    if (lowStock[0].count > 0) {
      alerts.push({
        type: "info",
        title: "Stock bajo",
        message: `${lowStock[0].count} productos con stock bajo`,
        action: "Ver productos",
        actionUrl: "/stock?stockStatus=bajo",
      })
    }

    // Clientes con saldo alto en cuenta corriente
    const [highBalance] = await pool.query(`
      SELECT COUNT(*) as count FROM clientes 
      WHERE activo = TRUE AND tiene_cuenta_corriente = TRUE 
      AND saldo_cuenta_corriente > 100000
    `)

    if (highBalance[0].count > 0) {
      alerts.push({
        type: "info",
        title: "Saldos altos",
        message: `${highBalance[0].count} clientes con saldo alto en cuenta corriente`,
        action: "Ver clientes",
        actionUrl: "/cuenta-corriente",
      })
    }

    res.status(200).json({
      success: true,
      data: alerts,
    })
  } catch (error) {
    console.error("Error al obtener alertas del sistema:", error)
    res.status(500).json({
      success: false,
      message: "Error al obtener alertas del sistema",
      error: error.message,
    })
  }
}
