import { Router } from "express"
import { check } from "express-validator"
import { register, login, logout } from "../controllers/auth.controller.js"
import { verifyToken } from "../middlewares/verifyToken.js"

const router = Router()

// Validación de datos para el registro
const validateRegisterSchema = [
  check("nombre").notEmpty().withMessage("El nombre es obligatorio"),
  check("password").isLength({ min: 6 }).withMessage("La contraseña debe tener al menos 6 caracteres"),
  check("rol").optional().isIn(["admin", "empleado"]).withMessage("El rol debe ser admin o empleado"),
]

// Validación de datos para el login
const validateLoginSchema = [
  check("nombre").notEmpty().withMessage("Debe ser un nombre de usuario válido"),
  check("password").notEmpty().withMessage("La contraseña es obligatoria"),
]

// Ruta para chequear si el usuario tiene sesión activa
router.get("/check-session", verifyToken(), (req, res) => {
  res.status(200).json({
    message: "Sesión activa",
    user: req.user,
  })
})

// Rutas de autenticación
router.post("/register", validateRegisterSchema, register)
router.post("/login", validateLoginSchema, login)
router.post("/logout", logout)

// Ruta protegida solo para admins (ejemplo)
router.get("/admin-only", verifyToken(["admin"]), (req, res) => {
  res.status(200).json({
    message: "Acceso autorizado para admin",
    user: req.user,
  })
})

export default router
