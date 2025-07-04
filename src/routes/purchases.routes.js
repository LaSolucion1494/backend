import { Router } from "express"
import { check } from "express-validator"
import {
  getPurchases,
  getPurchaseById,
  createPurchase,
  updatePurchaseStatus,
  receivePurchaseItems,
  cancelPurchase,
  getPurchasePaymentStats,
} from "../controllers/purchases.controller.js"
import { verifyToken } from "../middlewares/verifyToken.js"

const router = Router()

// Validaciones para crear compra (ACTUALIZADO para incluir pagos)
const validateCreatePurchase = [
  check("proveedorId").isInt({ min: 1 }).withMessage("Proveedor ID debe ser un número válido"),
  check("detalles").isArray({ min: 1 }).withMessage("Debe incluir al menos un producto"),
  check("detalles.*.productoId").isInt({ min: 1 }).withMessage("Producto ID debe ser un número válido"),
  check("detalles.*.cantidad").isInt({ min: 1 }).withMessage("Cantidad debe ser un número positivo"),
  check("detalles.*.precioUnitario").isFloat({ min: 0 }).withMessage("Precio unitario debe ser un número positivo"),
  check("subtotal").isFloat({ min: 0 }).withMessage("Subtotal debe ser un número positivo"),
  check("total").isFloat({ min: 0 }).withMessage("Total debe ser un número positivo"),
  check("fechaCompra").isDate().withMessage("Fecha de compra debe ser una fecha válida"),
  check("recibirInmediatamente")
    .optional()
    .isBoolean()
    .withMessage("Recibir inmediatamente debe ser verdadero o falso"),
  // NUEVAS VALIDACIONES PARA PAGOS
  check("pagos")
    .isArray({ min: 1 })
    .withMessage("Debe incluir al menos un método de pago"),
  check("pagos.*.tipo")
    .isIn(["efectivo", "transferencia", "tarjeta_credito", "tarjeta_debito", "otro"])
    .withMessage("Tipo de pago inválido"),
  check("pagos.*.monto").isFloat({ min: 0.01 }).withMessage("Monto de pago debe ser mayor a 0"),
  check("pagos.*.descripcion").optional().isLength({ max: 200 }).withMessage("Descripción del pago muy larga"),
]

// Validaciones para actualizar estado
const validateUpdateStatus = [
  check("estado").isIn(["pendiente", "parcial", "recibida", "cancelada"]).withMessage("Estado no válido"),
]

// Validaciones para recibir productos
const validateReceiveItems = [
  check("detallesRecibidos").isArray({ min: 1 }).withMessage("Debe incluir al menos un producto para recibir"),
  check("detallesRecibidos.*.detalleId").isInt({ min: 1 }).withMessage("Detalle ID debe ser un número válido"),
  check("detallesRecibidos.*.cantidadRecibida")
    .isInt({ min: 1 })
    .withMessage("Cantidad recibida debe ser un número positivo"),
]

// Rutas
router.get("/", verifyToken(), getPurchases)
router.get("/payment-stats", verifyToken(), getPurchasePaymentStats) // NUEVA RUTA
router.get("/:id", verifyToken(), getPurchaseById)
router.post("/", verifyToken(), validateCreatePurchase, createPurchase)
router.put("/:id/status", verifyToken(), validateUpdateStatus, updatePurchaseStatus)
router.post("/:id/receive", verifyToken(), validateReceiveItems, receivePurchaseItems)
router.put("/:id/cancel", verifyToken(), cancelPurchase)

export default router
