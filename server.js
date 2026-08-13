require("dotenv").config();
const { registerConfiguredProviders } = require("./src/services/provider.bootstrap");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const mongoSanitize = require("express-mongo-sanitize");
const {
  startPeyflexFundingReconciliationWorker,
} = require("./src/workers/peyflex.funding.reconciliation.worker");
const { connectDB } = require("./src/config/db");
const { notFound, errorHandler } = require("./src/middleware/error");
const { response } = require("./src/middleware/response");
const { apiLimiter, authLimiter } = require("./src/middleware/rateLimit");
const { seedAdmin } = require("./src/utils/seedAdmin");
const { startTransactionWorker } = require("./src/services/tx.processor");
const { startReconciliationWorker } = require("./src/services/tx.reconciliation");
const {
  startPeyflexFundingWorker,
} = require("./src/workers/peyflex.funding.worker");

if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET must be configured in production");
}

registerConfiguredProviders();

const app = express();

// 1. TRUST PROXY (Must be early for cPanel/Litespeed)
app.set("trust proxy", 1);

// 2. CORS CONFIGURATION (THE FIX)
// Use an explicit production allowlist; only non-browser requests bypass origin checks.
const allowedOrigins = String(process.env.FRONTEND_URLS || process.env.FRONTEND_URL || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (process.env.NODE_ENV === "production" && allowedOrigins.length === 0) {
  throw new Error("FRONTEND_URL or FRONTEND_URLS must be configured in production");
}

const corsOptions = {
  origin(origin, callback) {
    // Allow non-browser/server-to-server requests.
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (process.env.NODE_ENV !== "production" && /^https?:\/\/(localhost|127\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error("CORS origin not allowed"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization", "x-device-id", "X-Idempotency-Key", "X-Requested-With", "Accept"]
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// 3. SECURITY & LOGGING
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// 4. WEBHOOKS (Must be before JSON parser)
app.use("/api/paystack/webhook", express.raw({ type: "application/json" }), require("./src/routes/paystack.webhook"));
app.use("/api/wallet/korapay/webhook", express.raw({ type: "application/json" }), require("./src/routes/korapay.webhook"));
app.use("/api/transfer/korapay/webhook", express.raw({ type: "application/json" }), require("./src/routes/korapay.transfer.webhook"));
// SMEData sends JSON webhooks. Mount before the global JSON middleware so the
// route can acknowledge quickly and resolve the matching NEX transaction.
app.use("/api/webhook", express.json({ limit: "100kb" }), require("./src/routes/webhook.routes"));

// 5. STANDARD MIDDLEWARE
app.use(express.json({ limit: "300kb" }));
app.use(express.urlencoded({ extended: true, limit: "300kb" }));
app.use(mongoSanitize());
app.use(response);

// Rate limits apply to application APIs; webhooks were mounted above and are excluded.
app.use("/api", apiLimiter);

// Authentication gets a stricter limit on top of the general API limit.
app.use("/api/auth", authLimiter);

// 6. HEALTH ROUTES
app.get("/", (req, res) => res.status(200).json({ ok: true, message: "NEX API Active" }));
app.get("/api/health", (req, res) => {
  const mongoose = require("mongoose");
  res.status(200).json({
    ok: true,
    db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    timestamp: new Date().toISOString()
  });
});

// 7. APPLICATION ROUTES
app.use("/api/auth", require("./src/routes/auth.routes"));
app.use("/api/wallet", require("./src/routes/wallet.routes"));
app.use("/api/plans", require("./src/routes/plans.routes"));
app.use("/api/purchase", require("./src/routes/purchase.routes"));
app.use("/api/tx", require("./src/routes/transactions.routes"));
app.use("/api/notifications", require("./src/routes/notifications.routes"));
app.use("/api/adverts", require("./src/routes/adverts.routes"));
app.use("/api/campaigns", require("./src/routes/campaigns.routes"));
app.use("/api/loyalty", require("./src/routes/loyalty.routes"));
app.use("/api/services", require("./src/routes/services.routes"));
app.use("/api/providers", require("./src/routes/providers.routes"));
app.use("/api/virtual-account", require("./src/routes/virtual-account.routes"));
app.use("/api/transfer", require("./src/routes/transfer.routes"));
app.use("/api/admin", require("./src/routes/admin.routes"));
app.use("/api/airtime", require("./src/routes/airtime.routes"));
app.use("/api/electricity", require("./src/routes/electricity.routes"));
app.use("/api/cable", require("./src/routes/cable.routes"));

// 8. ERROR HANDLING
app.use(notFound);
app.use(errorHandler);

// 9. SERVER STARTUP (FAIL-SAFE)
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);

  const startServices = async () => {
    try {
      await connectDB();
      console.log("✅ MongoDB Connected");

      // FAIL-SAFE SEEDING: If this fails, the server DOES NOT crash
      try {
        await seedAdmin();
      } catch (seedErr) {
        console.error("⚠️ Seed failed but server is fine:", seedErr.message);
      }

      // Start the durable transaction worker only after MongoDB is ready.
      startTransactionWorker();
console.log("⚡ NEX transaction worker started");

startReconciliationWorker();
console.log("🔎 NEX transaction reconciliation worker started");

startPeyflexFundingWorker();
console.log("💰 NEX Peyflex funding worker started");
startPeyflexFundingReconciliationWorker();
console.log("🔎 NEX Peyflex funding reconciliation worker started");
    } catch (dbErr) {
      console.error("❌ Database connection failed:", dbErr.message);
    }
  };

  startServices();
});