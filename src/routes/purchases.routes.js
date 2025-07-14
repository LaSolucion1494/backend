import { Router } from "express"
import { check } from "express-validator"
import {
  createPurchase,
  getPurchases,
  getPurchaseById,
  receivePurchaseItems,
  cancelPurchase,
  updatePurchase,
  getPurchasesForReports,
  getPurchaseStats,
} from "../controllers/purchases.controller.js"
import { verifyToken } from "../middlewares/verifyToken.js"

const router = Router()

// Validaciones para crear compra
const validatePurchaseSchema = [
  check("proveedorId").isInt({ min: 1 }).withMessage("Proveedor ID es requerido"),
  check("productos").isArray({ min: 1 }).withMessage("Debe incluir al menos un producto"),
  check("productos.*.productoId").isInt({ min: 1 }).withMessage("ID de producto inválido"),
  check("productos.*.cantidad").isInt({ min: 1 }).withMessage("Cantidad debe ser mayor a 0"),
  check("productos.*.precioUnitario").optional().isFloat({ min: 0 }).withMessage("Precio unitario inválido"),
  check("descuento").optional().isFloat({ min: 0 }).withMessage("Descuento inválido"),
  check("interes").optional().isFloat({ min: 0 }).withMessage("Interés inválido"),
  // CORREGIDO: Validación de fecha más flexible
  check("fechaCompra")
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage("Fecha de compra debe estar en formato YYYY-MM-DD")
    .isISO8601()
    .withMessage("Fecha de compra inválida"),
  check("pagos").isArray({ min: 1 }).withMessage("Debe incluir al menos un método de pago"),
  check("pagos.*.tipo")
    .isIn(["efectivo", "transferencia", "tarjeta_credito", "tarjeta_debito", "otro"])
    .withMessage("Tipo de pago inválido"),
  check("pagos.*.monto").isFloat({ min: 0.01 }).withMessage("Monto de pago debe ser mayor a 0"),
  check("observaciones").optional().isLength({ max: 500 }).withMessage("Observaciones muy largas"),
  check("recibirInmediatamente")
    .optional()
    .isBoolean()
    .withMessage("recibirInmediatamente debe ser un booleano"), // ADDED
]

// Validaciones para recibir productos
const validateReceiveItemsSchema = [
  check("detallesRecibidos").isArray({ min: 1 }).withMessage("Debe incluir al menos un detalle"),
  check("detallesRecibidos.*.detalleId").isInt({ min: 1 }).withMessage("ID de detalle inválido"),
  check("detallesRecibidos.*.cantidadRecibida").isInt({ min: 1 }).withMessage("Cantidad recibida debe ser mayor a 0"),
]

// Validaciones para cancelar compra
const validateCancelPurchaseSchema = [
  check("motivo")
    .notEmpty()
    .isLength({ max: 200 })
    .withMessage("El motivo de cancelación es obligatorio y no puede exceder 200 caracteres"),
]

// Rutas de consulta
router.get("/", verifyToken(), getPurchases)
router.get("/reports", verifyToken(), getPurchasesForReports)
router.get("/stats", verifyToken(), getPurchaseStats)
router.get("/:id", verifyToken(), getPurchaseById)

// Rutas de operaciones
router.post("/", verifyToken(), validatePurchaseSchema, createPurchase)
router.put("/:id", verifyToken(), updatePurchase)
router.post("/:id/receive", verifyToken(), validateReceiveItemsSchema, receivePurchaseItems)

// Rutas administrativas
router.patch("/:id/cancel", verifyToken(["admin"]), validateCancelPurchaseSchema, cancelPurchase)

export default router
