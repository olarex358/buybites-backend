require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const mongoSanitize = require("express-mongo-sanitize");

const { connectDB } = require("./src/config/db");
const { apiLimiter } = require("./src/middleware/rateLimit");
const { errorHandler, notFound } = require("./src/middleware/error");

const app = express();

// Security headers
app.use(helmet());

// CORS (lock to frontend)
app.use(
  cors({
    origin: [process.env.FRONTEND_URL].filter(Boolean),
    credentials: false,
  })
);

// Logging
app.use(morgan("dev"));

// Webhook MUST be RAW first
app.use("/api/paystack", require("./src/routes/paystack.webhook"));

// JSON for other routes
app.use(express.json({ limit: "200kb" }));
app.use(mongoSanitize());
app.use("/api", apiLimiter);

app.get("/", (req, res) => res.send("BuyBites API ✅"));

app.use("/api/auth", require("./src/routes/auth.routes"));
app.use("/api/wallet", require("./src/routes/wallet.routes"));
app.use("/api/plans", require("./src/routes/plans.routes"));
app.use("/api/purchase", require("./src/routes/purchase.routes"));
app.use("/api/peyflex", require("./src/routes/peyflex.routes"));
app.use("/api/admin", require("./src/routes/admin.routes"));


app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`)))
  .catch((e) => {
    console.error("❌ DB failed:", e.message);
    process.exit(1);
  });
