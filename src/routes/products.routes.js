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
  getProductPriceBreakdown,
  updateProductPrices,
  searchProducts,
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

// Validaciones para actualización de precios
const validatePriceUpdateSchema = [
  check("precio_costo").isFloat({ min: 0 }).withMessage("El precio de costo debe ser un número positivo"),
  check("precio_venta").optional().isFloat({ min: 0 }).withMessage("El precio de venta debe ser un número positivo"),
]

// --- Rutas de Productos ---
// IMPORTANTE: Las rutas específicas deben ir ANTES que las rutas con parámetros

// Ruta de búsqueda (debe ir antes de /:id)
router.get("/search", verifyToken(), searchProducts)

// Ruta de validación de código
router.post("/validate-code", verifyToken(), validateProductCode)

// Rutas principales
router.get("/", verifyToken(), getProducts)
router.post("/", verifyToken(), validateProductSchema, createProduct)

// Rutas con parámetros específicos (deben ir antes de /:id genérico)
router.get("/code/:code", verifyToken(), getProductByCode)

// Rutas con ID genérico (deben ir al final)
router.get("/:id", verifyToken(), getProductById)
router.get("/:id/price-breakdown", verifyToken(), getProductPriceBreakdown)
router.put("/:id", verifyToken(), validateProductUpdateSchema, updateProduct)
router.put("/:id/prices", verifyToken(), validatePriceUpdateSchema, updateProductPrices)
router.delete("/:id", verifyToken(["admin"]), deleteProduct)

export default router
