// cotizaciones.routes.js
import { Router } from "express"
import { check } from "express-validator"
import {
  createCotizacion,
  getCotizaciones,
  getCotizacionById,
  getCotizacionesByClient,
  updateCotizacion,
  cancelCotizacion,
  getCotizacionesStats,
  convertCotizacionToPresupuesto,
  updateCotizacionStatus,
} from "../controllers/cotizaciones.controller.js"
import { verifyToken } from "../middlewares/verifyToken.js"

const router = Router()

// Validaciones para crear cotización
const validateCotizacionSchema = [
  check("clienteId").isInt({ min: 1 }).withMessage("Cliente ID es requerido"),
  check("productos").isArray({ min: 1 }).withMessage("Debe incluir al menos un producto"),
  check("productos.*.productoId").isInt({ min: 1 }).withMessage("ID de producto inválido"),
  check("productos.*.cantidad").isInt({ min: 1 }).withMessage("Cantidad debe ser mayor a 0"),
  check("productos.*.precioUnitario").optional().isFloat({ min: 0 }).withMessage("Precio unitario inválido"),
  check("descuento").optional().isFloat({ min: 0 }).withMessage("Descuento inválido"),
  check("interes").optional().isFloat({ min: 0 }).withMessage("Interés inválido"),
  check("fechaCotizacion").isDate().withMessage("Fecha de cotización inválida"),
  check("fechaVencimiento").optional().isDate().withMessage("Fecha de vencimiento inválida"),
  check("validezDias").optional().isInt({ min: 1, max: 365 }).withMessage("Validez debe ser entre 1 y 365 días"),
  check("observaciones").optional().isLength({ max: 500 }).withMessage("Observaciones muy largas"),
  check("condicionesComerciales").optional().isLength({ max: 1000 }).withMessage("Condiciones comerciales muy largas"),
  check("tiempoEntrega").optional().isLength({ max: 100 }).withMessage("Tiempo de entrega muy largo"),
]

// Validaciones para actualizar cotización
const validateUpdateCotizacionSchema = [
  check("observaciones").optional().isLength({ max: 500 }).withMessage("Observaciones muy largas"),
  check("condicionesComerciales").optional().isLength({ max: 1000 }).withMessage("Condiciones comerciales muy largas"),
  check("tiempoEntrega").optional().isLength({ max: 100 }).withMessage("Tiempo de entrega muy largo"),
  check("fechaVencimiento").optional().isDate().withMessage("Fecha de vencimiento inválida"),
]

// Validaciones para cambiar estado
const validateStatusUpdateSchema = [
  check("estado").isIn(["activa", "vencida", "aceptada", "rechazada", "anulada"]).withMessage("Estado inválido"),
  check("motivo").optional().isLength({ max: 200 }).withMessage("Motivo muy largo"),
]

// Validaciones para anular cotización
const validateCancelCotizacionSchema = [
  check("motivo")
    .notEmpty()
    .isLength({ max: 200 })
    .withMessage("El motivo de anulación es obligatorio y no puede exceder 200 caracteres"),
]

// Rutas de consulta (requieren autenticación básica)
router.get("/", verifyToken(), getCotizaciones)
router.get("/stats", verifyToken(), getCotizacionesStats)
router.get("/:id", verifyToken(), getCotizacionById)
router.get("/client/:clientId", verifyToken(), getCotizacionesByClient)

// Rutas de operaciones (requieren autenticación)
router.post("/", verifyToken(), validateCotizacionSchema, createCotizacion)
router.put("/:id", verifyToken(), validateUpdateCotizacionSchema, updateCotizacion)
router.patch("/:id/status", verifyToken(), validateStatusUpdateSchema, updateCotizacionStatus)

// Rutas administrativas (requieren permisos de admin)
router.patch("/:id/cancel", verifyToken(["admin"]), validateCancelCotizacionSchema, cancelCotizacion)
router.post("/:id/convert-to-presupuesto", verifyToken(), convertCotizacionToPresupuesto)

export default router
