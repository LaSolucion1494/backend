// clients.routes.js
import { Router } from "express"
import { check } from "express-validator"
import {
  getClients,
  getClientById,
  createClient,
  updateClient,
  toggleClientStatus,
  deleteClient,
  searchClients,
} from "../controllers/clients.controller.js"
import { verifyToken } from "../middlewares/verifyToken.js"

const router = Router()

// Validaciones para crear/actualizar cliente
const validateClientSchema = [
  check("nombre").notEmpty().withMessage("El nombre es obligatorio"),
  check("email").optional({ nullable: true }).isEmail().withMessage("Email inválido"),
  check("telefono").optional({ nullable: true }),
  check("direccion").optional({ nullable: true }),
  check("cuit").optional({ nullable: true }),
  check("notas").optional({ nullable: true }),
]

// Rutas p��blicas (requieren autenticación básica)
router.get("/", verifyToken(), getClients)
router.get("/search", verifyToken(), searchClients)
router.get("/:id", verifyToken(), getClientById)

// Rutas que requieren autenticación
router.post("/", verifyToken(), validateClientSchema, createClient)
router.put("/:id", verifyToken(), validateClientSchema, updateClient)
router.patch("/:id/toggle-status", verifyToken(), toggleClientStatus) // CORREGIDO: agregado /toggle-status

// Ruta que requiere permisos de admin
router.delete("/:id", verifyToken(["admin"]), deleteClient)

export default router
