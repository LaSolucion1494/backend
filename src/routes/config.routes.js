import { Router } from "express"
import { check } from "express-validator"
import { getConfig, getConfigByKey, updateConfig, updateConfigByKey } from "../controllers/config.controller.js"
import { verifyToken } from "../middlewares/verifyToken.js"

const router = Router()

// Validaciones para actualizar configuración
const validateConfigSchema = [check("configs").isArray().withMessage("Se esperaba un array de configuraciones")]

const validateSingleConfigSchema = [check("valor").notEmpty().withMessage("El valor es obligatorio")]

// Rutas
router.get("/", verifyToken(), getConfig)
router.get("/:key", verifyToken(), getConfigByKey)
router.put("/", verifyToken(["admin"]), validateConfigSchema, updateConfig)
router.put("/:key", verifyToken(["admin"]), validateSingleConfigSchema, updateConfigByKey)

export default router
