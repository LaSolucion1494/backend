import { Router } from "express"
import { check } from "express-validator"
import { getCategories, createCategory, updateCategory, deleteCategory } from "../controllers/categories.controller.js"
import { verifyToken } from "../middlewares/verifyToken.js"

const router = Router()

// Validaciones para crear/actualizar categoría
const validateCategorySchema = [check("nombre").notEmpty().withMessage("El nombre es obligatorio")]

// Rutas
router.get("/", verifyToken(), getCategories)
router.post("/", verifyToken(["admin"]), validateCategorySchema, createCategory)
router.put("/:id", verifyToken(["admin"]), validateCategorySchema, updateCategory)
router.delete("/:id", verifyToken(["admin"]), deleteCategory)

export default router
