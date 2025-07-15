import { Router } from "express"
import { check } from "express-validator"
import { getSuppliers, createSupplier, updateSupplier, deleteSupplier, searchSuppliers } from "../controllers/suppliers.controller.js"
import { verifyToken } from "../middlewares/verifyToken.js"

const router = Router()

// Validaciones para crear/actualizar proveedor
const validateSupplierSchema = [
  check("nombre").notEmpty().withMessage("El nombre es obligatorio"),
  check("cuit").optional().isLength({ max: 15 }).withMessage("El CUIT no puede exceder 15 caracteres"),
  check("telefono").optional().isLength({ max: 20 }).withMessage("El teléfono no puede exceder 20 caracteres"),
  check("direccion").optional().isLength({ max: 500 }).withMessage("La dirección no puede exceder 500 caracteres"),
]

// Rutas
router.get("/", verifyToken(), getSuppliers)
router.get("/search", verifyToken(), searchSuppliers) // Nueva ruta para la búsqueda
router.post("/", verifyToken(["admin"]), validateSupplierSchema, createSupplier)
router.put("/:id", verifyToken(["admin"]), validateSupplierSchema, updateSupplier)
router.delete("/:id", verifyToken(["admin"]), deleteSupplier)

export default router