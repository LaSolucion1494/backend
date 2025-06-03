import { Router } from "express"
import { check } from "express-validator"
import {
  getSales,
  getSaleById,
  createSale,
  cancelSale,
  getSalesStats,
  getSalesByClient,
} from "../controllers/sales.controller.js"
import { verifyToken } from "../middlewares/verifyToken.js"

const router = Router()

// Validaciones para crear venta
const validateSaleSchema = [
  check("clienteId").isInt({ min: 1 }).withMessage("Cliente ID es requerido"),
  check("fechaVenta").isDate().withMessage("Fecha de venta inválida"),
  check("tipoPago").isIn(["efectivo", "tarjeta", "transferencia", "otro"]).withMessage("Tipo de pago inválido"),
  check("descuento").optional().isFloat({ min: 0 }).withMessage("Descuento debe ser mayor o igual a 0"),
  check("detalles").isArray({ min: 1 }).withMessage("Debe incluir al menos un producto"),
  check("detalles.*.productoId").isInt({ min: 1 }).withMessage("Producto ID es requerido"),
  check("detalles.*.cantidad").isInt({ min: 1 }).withMessage("Cantidad debe ser mayor a 0"),
  check("detalles.*.precioUnitario").isFloat({ min: 0 }).withMessage("Precio unitario debe ser mayor a 0"),
]

// Rutas públicas (requieren autenticación básica)
router.get("/", verifyToken(), getSales)
router.get("/stats", verifyToken(), getSalesStats)
router.get("/client/:clientId", verifyToken(), getSalesByClient)
router.get("/:id", verifyToken(), getSaleById)

// Rutas que requieren autenticación
router.post("/", verifyToken(), validateSaleSchema, createSale)

// Rutas que requieren permisos de admin
router.patch("/:id/cancel", verifyToken(["admin"]), cancelSale)

export default router
