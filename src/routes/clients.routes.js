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
  getCuentaCorrienteByClient,
  getResumenCuentasCorrientes,
} from "../controllers/clients.controller.js"
import { verifyToken } from "../middlewares/verifyToken.js"

const router = Router()

// Validaciones para crear/actualizar cliente (OPTIMIZADO para nueva estructura)
const validateClientSchema = [
  check("nombre").notEmpty().withMessage("El nombre es obligatorio"),
  check("email").optional({ nullable: true }).isEmail().withMessage("Email inválido"),
  check("telefono").optional({ nullable: true }),
  check("direccion").optional({ nullable: true }),
  check("cuit").optional({ nullable: true }),
  check("notas").optional({ nullable: true }),
  check("tieneCuentaCorriente").optional().isBoolean().withMessage("tieneCuentaCorriente debe ser boolean"),
  check("limiteCredito")
    .optional({ nullable: true })
    .isFloat({ min: 0 })
    .withMessage("Límite de crédito debe ser mayor o igual a 0"),
]

// Validaciones para toggle status
const validateToggleStatusSchema = [check("activo").isBoolean().withMessage("El campo activo debe ser boolean")]

// Rutas públicas (requieren autenticación básica)
router.get("/", verifyToken(), getClients)
router.get("/search", verifyToken(), searchClients)
router.get("/:id", verifyToken(), getClientById)

// RUTAS PARA CUENTA CORRIENTE OPTIMIZADAS
router.get("/:clientId/cuenta-corriente", verifyToken(), getCuentaCorrienteByClient)
router.get("/cuentas-corrientes/resumen", verifyToken(), getResumenCuentasCorrientes)

// Rutas que requieren autenticación
router.post("/", verifyToken(), validateClientSchema, createClient)
router.put("/:id", verifyToken(), validateClientSchema, updateClient)
router.patch("/:id/toggle-status", verifyToken(), validateToggleStatusSchema, toggleClientStatus)

// Rutas que requieren permisos de admin
router.delete("/:id", verifyToken(["admin"]), deleteClient)

export default router
