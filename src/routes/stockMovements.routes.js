import { Router } from "express"
import { check } from "express-validator"
import {
  getStockMovements,
  createStockMovement,
  getProductMovements,
} from "../controllers/stockMovements.controller.js"
import { verifyToken } from "../middlewares/verifyToken.js"

const router = Router()

// Validaciones para crear movimiento de stock
const validateStockMovementSchema = [
  check("productId").isInt({ min: 1 }).withMessage("ID de producto inválido"),
  check("tipo").isIn(["entrada", "salida", "ajuste"]).withMessage("Tipo de movimiento inválido"),
  check("cantidad").isInt({ min: 0 }).withMessage("La cantidad debe ser un número entero positivo"),
  check("motivo").notEmpty().withMessage("El motivo es obligatorio"),
]

// Rutas
router.get("/", verifyToken(), getStockMovements)
router.post("/", verifyToken(), validateStockMovementSchema, createStockMovement)
router.get("/product/:productId", verifyToken(), getProductMovements)

export default router
