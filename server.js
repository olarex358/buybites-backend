require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const mongoSanitize = require("express-mongo-sanitize");

const { connectDB } = require("./src/config/db");
const { apiLimiter } = require("./src/middleware/rateLimit");
const { notFound, errorHandler } = require("./src/middleware/error");

const app = express();
app.set("trust proxy", 1);

// -------------------- Security + logs --------------------
app.use(helmet());
app.use(morgan("dev"));

// -------------------- CORS (SAFE allowlist) --------------------
// Add your real frontend URL(s) in .env as FRONTEND_URL=https://your-frontend.com
// You can add more allowed origins by separating with commas in FRONTEND_URLS
const envUrls = (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const allowList = [
  ...envUrls,

  // Local dev (Live Server)
  "http://127.0.0.1:5500",
  "http://localhost:5500",

  // Optional if you run frontend on 3000
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const corsOptions = {
  origin: (origin, cb) => {
    // allow non-browser requests (no origin)
    if (!origin) return cb(null, true);

    if (allowList.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin));
  },
  credentials: false,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
  "Content-Type",
  "Authorization",
  "x-admin-key",
  "x-device-id"
],
};

app.use(cors(corsOptions));
// ✅ handle preflight
app.options("*", cors(corsOptions));

// -------------------- Paystack webhook (RAW first) --------------------
// IMPORTANT: webhook must use RAW body so signature verification works
app.use(
  "/api/paystack/webhook",
  express.raw({ type: "application/json" }),
  require("./src/routes/paystack.webhook")
);

// -------------------- JSON parser for all other routes --------------------
app.use(express.json({ limit: "300kb" }));
app.use(mongoSanitize());

// -------------------- Rate limit (after webhook, before api) --------------------
app.use("/api", apiLimiter);

// -------------------- Health --------------------
app.get("/", (req, res) => res.json({ ok: true, name: "BuyBites API" }));

// -------------------- Routes --------------------
app.use("/api/auth", require("./src/routes/auth.routes"));
app.use("/api/wallet", require("./src/routes/wallet.routes"));
app.use("/api/plans", require("./src/routes/plans.routes"));
app.use("/api/purchase", require("./src/routes/purchase.routes"));
app.use("/api/peyflex", require("./src/routes/peyflex.routes"));
app.use("/api/admin", require("./src/routes/admin.routes"));

// -------------------- Errors --------------------
app.use(notFound);
app.use(errorHandler);

// -------------------- Start --------------------
const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => {
    app.listen(PORT, () => console.log(`🚀 BuyBites API running on port ${PORT}`));
  })
  .catch((e) => {
    console.error("❌ DB connection failed:", e.message);
    process.exit(1);
  });
