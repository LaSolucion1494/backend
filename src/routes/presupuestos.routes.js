// presupuestos.routes.js
import { Router } from "express"
import { check } from "express-validator"
import {
  createPresupuesto,
  getPresupuestos,
  getPresupuestoById,
  updatePresupuestoEstado,
} from "../controllers/presupuestos.controller.js"
import { verifyToken } from "../middlewares/verifyToken.js"

const router = Router()

// Validaciones para crear presupuesto
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
  check("observaciones").optional().isLength({ max: 500 }).withMessage("Observaciones muy largas"),
  check("validezDias").optional().isInt({ min: 1, max: 365 }).withMessage("Validez debe ser entre 1 y 365 días"),
]

// Validaciones para actualizar estado
const validateUpdateEstadoSchema = [
  check("estado").isIn(["activo", "convertido", "vencido", "cancelado"]).withMessage("Estado inválido"),
  check("observaciones").optional().isLength({ max: 200 }).withMessage("Observaciones muy largas"),
]

// Rutas de consulta
router.get("/", verifyToken(), getPresupuestos)
router.get("/:id", verifyToken(), getPresupuestoById)

// Rutas de operaciones
router.post("/", verifyToken(), validatePresupuestoSchema, createPresupuesto)
router.patch("/:id/estado", verifyToken(), validateUpdateEstadoSchema, updatePresupuestoEstado)

export default router
