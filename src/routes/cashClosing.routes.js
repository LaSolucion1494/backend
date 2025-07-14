import { Router } from "express"
import { check } from "express-validator"
import {
  createCashClosing,
  getCashClosings,
  getCashClosingById,
  getPendingCashClosingData,
} from "../controllers/cashClosing.controller.js"
import { verifyToken } from "../middlewares/verifyToken.js"

const router = Router()

// Validaciones para crear cierre de caja
const validateCreateCashClosing = [
  check("saldoInicialCaja").isFloat({ min: 0 }).withMessage("Saldo inicial de caja inválido"),
  check("fechaCierre")
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage("Fecha de cierre debe estar en formato YYYY-MM-DD")
    .isISO8601()
    .withMessage("Fecha de cierre inválida"),
  check("horaCierre")
    .matches(/^\d{2}:\d{2}$/)
    .withMessage("Hora de cierre debe estar en formato HH:MM"),
  check("detalles").isArray({ min: 0 }).withMessage("Los detalles del cierre son requeridos"),
  check("observaciones").optional().isLength({ max: 500 }).withMessage("Observaciones muy largas"),
]

// Rutas de consulta
router.get("/pending", verifyToken(), getPendingCashClosingData)
router.get("/", verifyToken(["admin"]), getCashClosings)
router.get("/:id", verifyToken(["admin"]), getCashClosingById)

// Rutas de operaciones
router.post("/", verifyToken(["admin"]), validateCreateCashClosing, createCashClosing)

export default router
