import { Router } from "express"
import { check } from "express-validator"
import {
  getPurchases,
  getPurchaseById,
  createPurchase,
  updatePurchaseStatus,
  receivePurchaseItems,
  cancelPurchase,
} from "../../controllers/compras/purchases.controller.js"
import { verifyToken } from "../../middlewares/verifyToken.js"

const router = Router()

// Validaciones para crear compra
const validatePurchaseSchema = [
  check("proveedorId").isInt({ min: 1 }).withMessage("ID de proveedor inválido"),
  check("fechaCompra").isDate().withMessage("Fecha de compra inválida"),
  check("descuento").optional().isFloat({ min: 0 }).withMessage("El descuento debe ser un número positivo"),
  check("detalles").isArray({ min: 1 }).withMessage("La compra debe tener al menos un producto"),
  check("detalles.*.productoId").isInt({ min: 1 }).withMessage("ID de producto inválido"),
  check("detalles.*.cantidad").isInt({ min: 1 }).withMessage("La cantidad debe ser un número entero positivo"),
  check("detalles.*.precioUnitario").isFloat({ min: 0 }).withMessage("El precio unitario debe ser un número positivo"),
]

// Validaciones para actualizar estado
const validateStatusUpdateSchema = [
  check("estado")
    .isIn(["pendiente", "recibida", "parcial", "cancelada"])
    .withMessage("Estado inválido"),
]

// Validaciones para recibir productos
const validateReceiveItemsSchema = [
  check("detallesRecibidos").isArray({ min: 1 }).withMessage("Debe especificar al menos un producto a recibir"),
  check("detallesRecibidos.*.detalleId").isInt({ min: 1 }).withMessage("ID de detalle inválido"),
  check("detallesRecibidos.*.cantidadRecibida")
    .isInt({ min: 1 })
    .withMessage("La cantidad recibida debe ser un número entero positivo"),
]

// Rutas públicas (requieren autenticación básica)
router.get("/", verifyToken(), getPurchases)
router.get("/:id", verifyToken(), getPurchaseById)

// Rutas que requieren autenticación
router.post("/", verifyToken(), validatePurchaseSchema, createPurchase)
router.patch("/:id/status", verifyToken(), validateStatusUpdateSchema, updatePurchaseStatus)
router.post("/:id/receive", verifyToken(), validateReceiveItemsSchema, receivePurchaseItems)

// Rutas que requieren permisos de admin
router.delete("/:id/cancel", verifyToken(["admin"]), cancelPurchase)

export default router