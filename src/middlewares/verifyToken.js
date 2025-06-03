import jwt from "jsonwebtoken"
import { JWT_SECRET } from "../config.js"

export const verifyToken = (roles = []) => {
  return (req, res, next) => {
    try {
      const token = req.cookies?.["token-jwt"]
      if (!token) {
        return res.status(401).json({ message: "No autorizado, token faltante" })
      }

      const decoded = jwt.verify(token, JWT_SECRET)

      // Establecer req.user con información consistente
      req.user = {
        id: decoded.id,
        nombre: decoded.nombre,
        rol: decoded.rol,
      }

      // Verificar roles si se especificaron
      if (roles.length > 0 && !roles.includes(req.user.rol)) {
        return res.status(403).json({ message: "Acceso denegado, rol insuficiente" })
      }

      next()
    } catch (error) {
      console.error("Error en verifyToken:", error)
      const statusCode = error.name === "TokenExpiredError" ? 401 : 403
      return res.status(statusCode).json({
        message: error.name === "TokenExpiredError" ? "El token ha expirado" : "Token inválido",
        error: error.message,
      })
    }
  }
}
