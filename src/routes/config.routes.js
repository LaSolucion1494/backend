import { Router } from "express"
import { check } from "express-validator"
import { getConfig, updateConfig, recalculateAllPrices } from "../controllers/config.controller.js"
import { verifyToken } from "../middlewares/verifyToken.js"

const router = Router()

// Validaciones para actualizar configuración
const validateConfigSchema = [
  check("configs").isArray({ min: 1 }).withMessage("Se esperaba un array de configuraciones no vacío"),
  check("configs.*.clave").notEmpty().withMessage("La clave de configuración es obligatoria"),
  check("configs.*.valor").notEmpty().withMessage("El valor de la configuración es obligatorio"),
]

// --- Rutas de Configuración ---

// Obtener toda la configuración
router.get("/", verifyToken(), getConfig)

// Actualizar una o varias configuraciones
router.put("/", verifyToken(["admin"]), validateConfigSchema, updateConfig)

// Forzar el recálculo de todos los precios de venta
router.post("/recalculate-prices", verifyToken(["admin"]), recalculateAllPrices)

export default router
