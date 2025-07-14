// sales.routes.js
import { Router } from "express"
import { check } from "express-validator"
import {
  createSale,
  getSales,
  getSaleById,
  getSalesByClient,
  cancelSale,
  getSalesStats,
  getDailySummary,
  updateSale,
} from "../controllers/sales.controller.js"
import { verifyToken } from "../middlewares/verifyToken.js"

const router = Router()

// Validaciones para crear venta (OPTIMIZADO)
const validateSaleSchema = [
  check("clienteId").isInt({ min: 1 }).withMessage("Cliente ID es requerido"),
  check("productos").isArray({ min: 1 }).withMessage("Debe incluir al menos un producto"),
  check("productos.*.productoId").isInt({ min: 1 }).withMessage("ID de producto inválido"),
  check("productos.*.cantidad").isInt({ min: 1 }).withMessage("Cantidad debe ser mayor a 0"),
  check("productos.*.precioUnitario").optional().isFloat({ min: 0 }).withMessage("Precio unitario inválido"),
  check("descuento").optional().isFloat({ min: 0 }).withMessage("Descuento inválido"),
  check("interes").optional().isFloat({ min: 0 }).withMessage("Interés inválido"),
  check("fechaVenta").isDate().withMessage("Fecha de venta inválida"),
  check("pagos").isArray({ min: 1 }).withMessage("Debe incluir al menos un método de pago"),
  check("pagos.*.tipo")
    .isIn(["efectivo", "tarjeta", "transferencia", "cuenta_corriente", "otro"])
    .withMessage("Tipo de pago inválido"),
  check("pagos.*.monto").isFloat({ min: 0.01 }).withMessage("Monto de pago debe ser mayor a 0"),
  check("pagos.*.descripcion").optional().isLength({ max: 200 }).withMessage("Descripción del pago muy larga"),
  check("observaciones").optional().isLength({ max: 500 }).withMessage("Observaciones muy largas"),
]

// Validaciones para actualizar venta
const validateUpdateSaleSchema = [
  check("observaciones").optional().isLength({ max: 500 }).withMessage("Observaciones muy largas"),
]

// Validaciones para anular venta
const validateCancelSaleSchema = [
  check("motivo")
    .notEmpty()
    .isLength({ max: 200 })
    .withMessage("El motivo de anulación es obligatorio y no puede exceder 200 caracteres"),
]

// Rutas de consulta (requieren autenticación básica)
router.get("/", verifyToken(), getSales)
router.get("/stats", verifyToken(), getSalesStats)
router.get("/daily-summary", verifyToken(), getDailySummary)
router.get("/summary/today", verifyToken(), getDailySummary)
router.get("/:id", verifyToken(), getSaleById)
router.get("/client/:clientId", verifyToken(), getSalesByClient)

// Rutas de operaciones (requieren autenticación)
router.post("/", verifyToken(), validateSaleSchema, createSale)
router.put("/:id", verifyToken(), validateUpdateSaleSchema, updateSale)

// Rutas administrativas (requieren permisos de admin)
router.patch("/:id/cancel", verifyToken(["admin"]), validateCancelSaleSchema, cancelSale)

export default router
