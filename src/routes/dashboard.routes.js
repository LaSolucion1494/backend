import { Router } from "express"
import {
  getDashboardData,
  getDashboardStats,
  getQuickSummary,
  getTopProducts,
  getSystemAlerts,
} from "../controllers/dashboard.controller.js"
import { verifyToken } from "../middlewares/verifyToken.js"

const router = Router()

// Rutas del dashboard (requieren autenticación)
router.get("/", verifyToken(), getDashboardData)
router.get("/stats", verifyToken(), getDashboardStats)
router.get("/quick-summary", verifyToken(), getQuickSummary)
router.get("/top-products", verifyToken(), getTopProducts)
router.get("/alerts", verifyToken(), getSystemAlerts)

export default router
