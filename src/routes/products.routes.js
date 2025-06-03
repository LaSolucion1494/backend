import { Router } from "express"
import { check } from "express-validator"
import {
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  getProductByCode,
  validateProductCode,
} from "../controllers/products.controller.js"
import { verifyToken } from "../middlewares/verifyToken.js"

const router = Router()

// Validaciones para crear/actualizar producto
const validateProductSchema = [
  check("codigo").notEmpty().withMessage("El código es obligatorio"),
  check("nombre").notEmpty().withMessage("El nombre es obligatorio"),
  check("precioCosto").isFloat({ min: 0 }).withMessage("El precio de costo debe ser un número positivo"),
  check("stock").optional().isInt({ min: 0 }).withMessage("El stock debe ser un número entero positivo"),
]

// Validaciones específicas para actualización (sin stock)
const validateProductUpdateSchema = [
  check("codigo").notEmpty().withMessage("El código es obligatorio"),
  check("nombre").notEmpty().withMessage("El nombre es obligatorio"),
  check("precioCosto").isFloat({ min: 0 }).withMessage("El precio de costo debe ser un número positivo"),
]

// Rutas públicas (requieren autenticación básica)
router.get("/", verifyToken(), getProducts)
router.get("/:id", verifyToken(), getProductById)

// Ruta para buscar por código
router.get("/code/:code", verifyToken(), getProductByCode)

// Ruta para validar código único
router.post("/validate-code", verifyToken(), validateProductCode)

// Rutas que requieren autenticación
router.post("/", verifyToken(), validateProductSchema, createProduct)
router.put("/:id", verifyToken(), validateProductUpdateSchema, updateProduct)

// Ruta que requiere permisos de admin
router.delete("/:id", verifyToken(["admin"]), deleteProduct)

export default router
