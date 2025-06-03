import bcrypt from "bcrypt"
import pool from "../db.js"
import { validationResult } from "express-validator"
import jwt from "jsonwebtoken"
import { JWT_SECRET } from "../config.js"

// Controlador para registrar un usuario
export const register = async (req, res) => {
  const errors = validationResult(req)

  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  const { nombre, password, rol = "empleado" } = req.body

  try {
    // Verificar si el usuario ya existe por nombre
    const [userByName] = await pool.query("SELECT * FROM usuarios WHERE nombre = ?", [nombre])
    if (userByName.length > 0) {
      return res.status(400).json({ message: "El nombre de usuario ya está registrado" })
    }

    // Validar que el rol sea válido
    if (!["admin", "empleado"].includes(rol)) {
      return res.status(400).json({ message: "Rol inválido. Debe ser admin o empleado" })
    }

    // Encriptar la contraseña
    const hashedPassword = await bcrypt.hash(password, 10)

    // Insertar el usuario en la base de datos
    await pool.query("INSERT INTO usuarios (nombre, password, rol) VALUES (?, ?, ?)", [nombre, hashedPassword, rol])

    res.status(201).json({ message: "Usuario registrado exitosamente" })
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: "Error al registrar el usuario" })
  }
}

// Controlador para login
export const login = async (req, res) => {
  const errors = validationResult(req)

  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }

  const { nombre, password } = req.body

  try {
    // Verificar si el usuario existe y está activo
    const [rows] = await pool.query("SELECT * FROM usuarios WHERE nombre = ? AND activo = TRUE", [nombre])

    if (rows.length === 0) {
      return res.status(404).json({ message: "Usuario no encontrado o inactivo" })
    }

    const user = rows[0]

    // Verificar la contraseña
    const isMatch = await bcrypt.compare(password, user.password)
    if (!isMatch) {
      return res.status(400).json({ message: "La contraseña es incorrecta" })
    }

    // Generar un token de acceso con información consistente
    const token = jwt.sign(
      {
        id: user.id,
        nombre: user.nombre,
        rol: user.rol,
      },
      JWT_SECRET,
      { expiresIn: "8h" },
    )

    // Configurar la cookie con el token
    res.cookie("token-jwt", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    })

    // Responder con los datos del usuario
    res.status(200).json({
      id: user.id,
      nombre: user.nombre,
      rol: user.rol,
    })
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: "Error interno del servidor" })
  }
}

export const logout = (req, res) => {
  res.clearCookie("token-jwt", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  })
  res.status(200).json({ message: "Sesión cerrada correctamente" })
}
