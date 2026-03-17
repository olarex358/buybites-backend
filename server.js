require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const mongoSanitize = require("express-mongo-sanitize");

const { connectDB } = require("./src/config/db");
const { apiLimiter } = require("./src/middleware/rateLimit");
const { notFound, errorHandler } = require("./src/middleware/error");
const { response } = require("./src/middleware/response"); // ✅ single clean import
const { seedAdmin } = require("./src/utils/seedAdmin");

const app = express();
app.set("trust proxy", 1);

// -------------------- Security + logs --------------------
app.use(helmet());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// -------------------- CORS --------------------
const envUrls = (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowList = [
  ...envUrls,
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowList.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin));
  },
  credentials: false,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-key", "x-device-id"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// -------------------- Paystack webhook (RAW body first) --------------------
app.use(
  "/api/paystack/webhook",
  express.raw({ type: "application/json" }),
  require("./src/routes/paystack.webhook")
);

// -------------------- JSON + sanitize --------------------
app.use(express.json({ limit: "300kb" }));
app.use(mongoSanitize());

// ✅ FIX: response middleware applied ONCE here (was applied twice before)
app.use(response);

// -------------------- Rate limit --------------------
app.use("/api", apiLimiter);

// -------------------- Health --------------------
app.get("/", (req, res) => res.json({ ok: true, name: "BuyBites API" }));

app.get("/api/health", async (req, res) => {
  try {
    const mongoose = require("mongoose");
    const dbConnected = mongoose.connection.readyState === 1;
    res.json({
      ok: true,
      service: "BuyBites API",
      uptime: process.uptime(),
      db: dbConnected ? "connected" : "disconnected",
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(500).json({ ok: false, error: "Health check failed" });
  }
});

// -------------------- Routes --------------------
app.use("/api/webhook",     require("./src/routes/webhook.routes"));
app.use("/api/auth",        require("./src/routes/auth.routes"));
app.use("/api/wallet",      require("./src/routes/wallet.routes"));
app.use("/api/plans",       require("./src/routes/plans.routes"));
app.use("/api/purchase",    require("./src/routes/purchase.routes"));
app.use("/api/tx",          require("./src/routes/transactions.routes"));
app.use("/api/peyflex",     require("./src/routes/peyflex.routes"));
app.use("/api/admin",       require("./src/routes/admin.routes"));
app.use("/api/airtime",     require("./src/routes/airtime.routes"));
app.use("/api/electricity", require("./src/routes/electricity.routes"));
app.use("/api/cable", require("./src/routes/cable.routes"));

// -------------------- Errors --------------------
app.use(notFound);
app.use(errorHandler);

// -------------------- Start --------------------
const PORT = process.env.PORT || 5000;

async function start() {
  try {
    await connectDB();
    await seedAdmin();
    app.listen(PORT, () => {
      console.log(`🚀 BuyBites API running on port ${PORT}`);
    });
  } catch (e) {
    console.error("❌ Startup failed:", e.message || e);
    process.exit(1);
  }
}

start();
