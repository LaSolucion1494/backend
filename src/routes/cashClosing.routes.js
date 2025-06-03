import { Router } from "express"
import { check } from "express-validator"
import {
  getDailySalesSummary,
  createCashClosing,
  getCashClosings,
  getCashClosingById,
  getCashClosingStats,
} from "../controllers/cashClosing.controller.js"
import { verifyToken } from "../middlewares/verifyToken.js"

const router = Router()

// Validaciones para crear cierre de caja
const validateCashClosingSchema = [
  check("efectivoEnCaja").isFloat({ min: 0 }).withMessage("El efectivo en caja debe ser mayor o igual a 0"),
  check("fechaCierre").optional().isDate().withMessage("Fecha de cierre inválida"),
  check("observaciones")
    .optional()
    .isLength({ max: 500 })
    .withMessage("Las observaciones no pueden exceder 500 caracteres"),
]

// Rutas que requieren autenticación
router.get("/daily-summary", verifyToken(), getDailySalesSummary)
router.get("/stats", verifyToken(), getCashClosingStats)
router.get("/", verifyToken(), getCashClosings)
router.get("/:id", verifyToken(), getCashClosingById)

// Rutas que requieren permisos específicos
router.post("/", verifyToken(["admin", "empleado"]), validateCashClosingSchema, createCashClosing)

export default router
