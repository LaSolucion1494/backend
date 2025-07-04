// routes/cuentaCorriente.routes.js - RUTAS COMPLETAS PARA CUENTA CORRIENTE
import { Router } from "express"
import { verifyToken } from "../middlewares/verifyToken.js"
import {
  registrarPago,
  getPagos,
  getPagosByClient,
  getPagoById,
  anularPago,
  getMovimientosByClient,
  getResumenCuentaCorriente,
  crearAjuste,
  getEstadisticasCuentaCorriente,
} from "../controllers/cuentaCorriente.controller.js"

const router = Router()

// Rutas para resumen y estadísticas
router.get("/", verifyToken(), getResumenCuentaCorriente)
router.get("/stats", verifyToken(), getEstadisticasCuentaCorriente)

// Rutas para pagos
router.post("/pagos", verifyToken(), registrarPago)
router.get("/pagos", verifyToken(), getPagos)
router.get("/pagos/:id", verifyToken(), getPagoById)
router.patch("/pagos/:id/anular", verifyToken(), anularPago)

// Rutas para ajustes
router.post("/ajustes", verifyToken(), crearAjuste)

// Rutas específicas por cliente
router.get("/client/:clientId/pagos", verifyToken(), getPagosByClient)
router.get("/client/:clientId/movimientos", verifyToken(), getMovimientosByClient)

export default router
