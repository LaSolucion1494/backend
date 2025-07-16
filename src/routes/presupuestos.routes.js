// presupuestos.routes.js - CORREGIDO
import { Router } from "express"
import { check } from "express-validator"
import {
  createPresupuesto,
  getPresupuestos,
  getPresupuestoById,
  updatePresupuestoEstado,
  cancelPresupuesto,
  deliverProductsPresupuesto,
  getPresupuestosStats,
  updatePresupuesto,
} from "../controllers/presupuestos.controller.js"
import { verifyToken } from "../middlewares/verifyToken.js"

const router = Router()

// Validaciones para crear presupuesto (IGUAL QUE VENTAS)
const validatePresupuestoSchema = [
  check("clienteId").isInt({ min: 1 }).withMessage("Cliente ID es requerido"),
  check("productos").isArray({ min: 1 }).withMessage("Debe incluir al menos un producto"),
  check("productos.*.productoId").isInt({ min: 1 }).withMessage("ID de producto inválido"),
  check("productos.*.cantidad").isInt({ min: 1 }).withMessage("Cantidad debe ser mayor a 0"),
  check("productos.*.precioUnitario").optional().isFloat({ min: 0 }).withMessage("Precio unitario inválido"),
  check("descuento").optional().isFloat({ min: 0 }).withMessage("Descuento inválido"),
  check("interes").optional().isFloat({ min: 0 }).withMessage("Interés inválido"),
  check("fechaPresupuesto").isDate().withMessage("Fecha de presupuesto inválida"),
  check("pagos").isArray({ min: 1 }).withMessage("Debe incluir al menos un método de pago"),
  check("pagos.*.tipo")
    .isIn(["efectivo", "tarjeta", "transferencia", "cuenta_corriente", "otro"])
    .withMessage("Tipo de pago inválido"),
  check("pagos.*.monto").isFloat({ min: 0.01 }).withMessage("Monto de pago debe ser mayor a 0"),
  check("pagos.*.descripcion").optional().isLength({ max: 200 }).withMessage("Descripción del pago muy larga"),
  check("observaciones").optional().isLength({ max: 500 }).withMessage("Observaciones muy largas"),
]

// Validaciones para actualizar presupuesto
const validateUpdatePresupuestoSchema = [
  check("observaciones").optional().isLength({ max: 500 }).withMessage("Observaciones muy largas"),
]

// Validaciones para anular presupuesto
const validateCancelPresupuestoSchema = [
  check("motivo")
    .notEmpty()
    .isLength({ max: 200 })
    .withMessage("El motivo de anulación es obligatorio y no puede exceder 200 caracteres"),
]

// Validaciones para entregar productos
const validateDeliverProductsSchema = [
  check("deliveries").isArray({ min: 1 }).withMessage("Debe especificar al menos un producto para entregar"),
  check("deliveries.*.detalleId").isInt({ min: 1 }).withMessage("ID de detalle de presupuesto inválido"),
  check("deliveries.*.quantity")
    .isInt({ min: 1 })
    .withMessage("La cantidad a entregar debe ser un número entero positivo"),
]

// Validaciones para actualizar estado - CORREGIDO
const validateUpdateEstadoSchema = [
  check("estado").isIn(["activo", "completado", "pendiente", "anulado"]).withMessage("Estado inválido"),
  check("observaciones").optional().isLength({ max: 200 }).withMessage("Observaciones muy largas"),
]

// Rutas de consulta
router.get("/", verifyToken(), getPresupuestos)
router.get("/stats", verifyToken(), getPresupuestosStats)
router.get("/:id", verifyToken(), getPresupuestoById)

// Rutas de operaciones
router.post("/", verifyToken(), validatePresupuestoSchema, createPresupuesto)
router.put("/:id", verifyToken(), validateUpdatePresupuestoSchema, updatePresupuesto)

// Rutas administrativas
router.patch("/:id/cancel", verifyToken(["admin"]), validateCancelPresupuestoSchema, cancelPresupuesto)
router.patch(
  "/:id/deliver",
  verifyToken(["admin", "empleado"]),
  validateDeliverProductsSchema,
  deliverProductsPresupuesto,
)
router.patch("/:id/estado", verifyToken(), validateUpdateEstadoSchema, updatePresupuestoEstado)

export default router
