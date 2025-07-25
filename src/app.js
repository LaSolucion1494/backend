// app.js
import express from "express"
import cors from "cors"
import bodyParser from "body-parser"
import cookieParser from "cookie-parser"
import { FRONTEND_URL, FRONTEND_URL_WWW, FRONTEND_URL_DEV } from "./config.js"

import authRoutes from "./routes/auth.routes.js"
import productsRoutes from "./routes/products.routes.js"
import categoriesRoutes from "./routes/categories.routes.js"
import suppliersRoutes from "./routes/suppliers.routes.js"
import stockMovementsRoutes from "./routes/stockMovements.routes.js"
import configRoutes from "./routes/config.routes.js"
import purchasesRoutes from "./routes/purchases.routes.js"
import clientsRoutes from "./routes/clients.routes.js"
import salesRoutes from "./routes/sales.routes.js"
import cashClosingRoutes from "./routes/cashClosing.routes.js"
import cuentaCorrienteRoutes from "./routes/cuentaCorriente.routes.js"
import dashboardRoutes from "./routes/dashboard.routes.js"
import presupuestosRoutes from "./routes/presupuestos.routes.js"
import cotizacionesRoutes from "./routes/cotizaciones.routes.js" // NUEVO: Importar rutas de cotizaciones

const app = express()

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  FRONTEND_URL,
  FRONTEND_URL_WWW,
  FRONTEND_URL_DEV,
]

// Configuración de CORS
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true)
    if (allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error("No permitido por CORS"))
    }
  },
  methods: ["POST", "PUT", "DELETE", "GET", "OPTIONS", "PATCH"],
  credentials: true,
}

app.use(express.json())
app.use(cookieParser())
app.use(bodyParser.json())
app.use(cors(corsOptions))

// Rutas existentes
app.use("/api/auth", authRoutes)
app.use("/api/products", productsRoutes)
app.use("/api/categories", categoriesRoutes)
app.use("/api/suppliers", suppliersRoutes)
app.use("/api/stock-movements", stockMovementsRoutes)
app.use("/api/config", configRoutes)
app.use("/api/purchases", purchasesRoutes)
app.use("/api/clientes", clientsRoutes)
app.use("/api/sales", salesRoutes)
app.use("/api/cash-closing", cashClosingRoutes)
app.use("/api/cuenta-corriente", cuentaCorrienteRoutes)
app.use("/api/dashboard", dashboardRoutes)
app.use("/api/presupuestos", presupuestosRoutes)
app.use("/api/cotizaciones", cotizacionesRoutes) // NUEVO: Usar rutas de cotizaciones

// Middleware para manejar errores
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).send({ error: "¡Algo salió mal!" })
})

export default app
