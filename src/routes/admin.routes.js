const router = require("express").Router();
const { adminOnly } = require("../middleware/admin");

const User = require("../models/User");
const WalletTx = require("../models/WalletTx");
const Order = require("../models/Order");
const DataPlan = require("../models/DataPlan");
const Pricing = require("../models/Pricing");
const { z } = require("zod");
const { auth } = require("../middleware/auth"); // you already have this
const { cleanPhone } = require("../utils/phone");
const bcrypt = require("bcryptjs");


router.use(auth);
router.use(adminOnly);

// ---------- helpers ----------
function toInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function csvEscape(val) {
  const s = String(val ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function toCsv(rows, columns) {
  const head = columns.map(c => csvEscape(c.label)).join(",");
  const body = rows.map(r =>
    columns.map(c => csvEscape(typeof c.value === "function" ? c.value(r) : r[c.value])).join(",")
  ).join("\n");
  return `${head}\n${body}\n`;
}

// ✅ 1) STATS
router.get("/stats", async (req, res, next) => {
  try {
    const [users, orders, walletTx, activePlans] = await Promise.all([
      User.countDocuments(),
      Order.countDocuments(),
      WalletTx.countDocuments(),
      DataPlan.countDocuments({ isActive: true }),
    ]);

    const [delivered, refunded, processing, failed] = await Promise.all([
      Order.countDocuments({ status: "DELIVERED" }),
      Order.countDocuments({ status: "REFUNDED" }),
      Order.countDocuments({ status: "PROCESSING" }),
      Order.countDocuments({ status: "FAILED" }),
    ]);

    return res.json({
      ok: true,
      stats: { users, orders, walletTx, activePlans, delivered, refunded, processing, failed },
    });
  } catch (e) {
    next(e);
  }
});

// ✅ 2) USERS (search + pagination)
router.get("/users", async (req, res, next) => {
  try {
    const page = clamp(toInt(req.query.page, 1), 1, 100000);
    const limit = clamp(toInt(req.query.limit, 20), 5, 100);
    const q = String(req.query.q || "").trim();

    const filter = q
      ? { $or: [{ phone: new RegExp(q, "i") }, { fullName: new RegExp(q, "i") }] }
      : {};

    const [total, users] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .select("phone fullName walletBalance isBlocked role tier totalVolume totalProfit createdAt")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
    ]);

    return res.json({ ok: true, page, limit, total, users });
  } catch (e) {
    next(e);
  }
});

// ✅ 3) ORDERS (filters + pagination)
router.get("/orders", async (req, res, next) => {
  try {
    const page = clamp(toInt(req.query.page, 1), 1, 100000);
    const limit = clamp(toInt(req.query.limit, 20), 5, 100);

    const status = String(req.query.status || "").trim();   // DELIVERED/PROCESSING/FAILED/REFUNDED
    const network = String(req.query.network || "").trim(); // mtn_sme_data...
    const phone = String(req.query.phone || "").trim();     // contains

    const filter = {};
    if (status) filter.status = status;
    if (network) filter.network = network;
    if (phone) filter.mobile_number = new RegExp(phone, "i");

    const [total, orders] = await Promise.all([
      Order.countDocuments(filter),
      Order.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
    ]);

    return res.json({ ok: true, page, limit, total, orders });
  } catch (e) {
    next(e);
  }
});

// ✅ 4) WALLET TX (filters + pagination)
router.get("/wallet-tx", async (req, res, next) => {
  try {
    const page = clamp(toInt(req.query.page, 1), 1, 100000);
    const limit = clamp(toInt(req.query.limit, 20), 5, 100);

    const type = String(req.query.type || "").trim();       // FUND/DEBIT/CREDIT
    const status = String(req.query.status || "").trim();   // PENDING/SUCCESS/FAILED
    const userId = String(req.query.userId || "").trim();   // optional

    const filter = {};
    if (type) filter.type = type;
    if (status) filter.status = status;
    if (userId) filter.userId = userId;

    const [total, tx] = await Promise.all([
      WalletTx.countDocuments(filter),
      WalletTx.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
    ]);

    return res.json({ ok: true, page, limit, total, tx });
  } catch (e) {
    next(e);
  }
});

// ✅ 5) PLANS (filters)
router.get("/plans", async (req, res, next) => {
  try {
    const network = String(req.query.network || "").trim();
    const isActive = String(req.query.isActive || "").trim(); // "true" | "false" | ""

    const filter = {};
    if (network) filter.network = network;
    if (isActive === "true") filter.isActive = true;
    if (isActive === "false") filter.isActive = false;

    const plans = await DataPlan.find(filter).sort({ network: 1, sellPrice: 1 });
    return res.json({ ok: true, plans });
  } catch (e) {
    next(e);
  }
});

// ✅ 6) EXPORT: ORDERS CSV
router.get("/export/orders.csv", async (req, res, next) => {
  try {
    const limit = clamp(toInt(req.query.limit, 5000), 100, 20000);
    const orders = await Order.find({}).sort({ createdAt: -1 }).limit(limit);

    const csv = toCsv(orders, [
      { label: "id", value: "_id" },
      { label: "userId", value: "userId" },
      { label: "network", value: "network" },
      { label: "plan_code", value: "plan_code" },
      { label: "mobile_number", value: "mobile_number" },
      { label: "amount", value: "amount" },
      { label: "status", value: "status" },
      { label: "providerRef", value: "providerRef" },
      { label: "lastError", value: "lastError" },
      { label: "createdAt", value: (r) => r.createdAt },
    ]);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="orders.csv"`);
    return res.send(csv);
  } catch (e) {
    next(e);
  }
});

// ✅ 7) EXPORT: WALLET TX CSV
router.get("/export/wallet.csv", async (req, res, next) => {
  try {
    const limit = clamp(toInt(req.query.limit, 5000), 100, 20000);
    const tx = await WalletTx.find({}).sort({ createdAt: -1 }).limit(limit);

    const csv = toCsv(tx, [
      { label: "id", value: "_id" },
      { label: "userId", value: "userId" },
      { label: "type", value: "type" },
      { label: "amount", value: "amount" },
      { label: "reference", value: "reference" },
      { label: "status", value: "status" },
      { label: "createdAt", value: (r) => r.createdAt },
    ]);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="wallet_tx.csv"`);
    return res.send(csv);
  } catch (e) {
    next(e);
  }
});

// ✅ 8) PRICING (manual tier pricing)
router.get("/pricing", async (req, res, next) => {
  try {
    const serviceType = String(req.query.serviceType || "").trim();
    const network = String(req.query.network || "").trim();
    const productCode = String(req.query.productCode || "").trim();

    const filter = {};
    if (serviceType) filter.serviceType = serviceType;
    if (network) filter.network = network;
    if (productCode) filter.productCode = productCode;

    const items = await Pricing.find(filter).sort({ serviceType: 1, network: 1, productCode: 1 });
    res.json({ ok: true, items });
  } catch (e) {
    next(e);
  }
});

router.put("/pricing", async (req, res, next) => {
  try {
    const b = z.object({
      serviceType: z.enum(["DATA", "AIRTIME", "ELECTRICITY", "TV", "PIN", "BETTING"]),
      network: z.string().optional().default(""),
      productCode: z.string().optional().default(""),
      prices: z.object({
        USER: z.number().optional(),
        BASIC: z.number().optional(),
        SILVER: z.number().optional(),
        GOLD: z.number().optional(),
        PLATINUM: z.number().optional(),
      }).default({}),
      baseCost: z.number().optional(),
      isActive: z.boolean().optional(),
    }).parse(req.body);

    const doc = await Pricing.findOneAndUpdate(
      { serviceType: b.serviceType, network: b.network, productCode: b.productCode },
      {
        serviceType: b.serviceType,
        network: b.network,
        productCode: b.productCode,
        prices: {
          USER: b.prices.USER ?? 0,
          BASIC: b.prices.BASIC ?? 0,
          SILVER: b.prices.SILVER ?? 0,
          GOLD: b.prices.GOLD ?? 0,
          PLATINUM: b.prices.PLATINUM ?? 0,
        },
        baseCost: b.baseCost ?? 0,
        isActive: b.isActive ?? true,
      },
      { upsert: true, new: true }
    );

    res.json({ ok: true, item: doc });
  } catch (e) {
    next(e);
  }
});

router.delete("/pricing/:id", async (req, res, next) => {
  try {
    await Pricing.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});


// ✅ Create Agent directly
router.post("/agents", async (req, res, next) => {
  try {
  const b = z.object({
    phone: z.string().min(8),
    pin: z.string().min(4).max(8),
    name: z.string().optional(),
    tier: z.enum(["USER","BASIC","SILVER","GOLD","PLATINUM"]).optional(),
  }).parse(req.body);

  const phone = cleanPhone(b.phone) || b.phone;

  const exists = await User.findOne({ phone }).select("_id");
  if (exists) return res.status(409).json({ ok: false, error: "User already exists" });

  const pinHash = await bcrypt.hash(String(b.pin), 12);

  const agent = await User.create({
    phone,
    pinHash,
    fullName: b.name || "",
    role: "AGENT",
    tier: b.tier || "BASIC",
  });

  res.json({ ok: true, agent: { id: agent._id, phone: agent.phone, role: agent.role, tier: agent.tier, fullName: agent.fullName } });
  } catch (e) {
    next(e);
  }
});

// ✅ Promote existing user to Agent/Admin
router.patch("/users/:id/role", async (req, res, next) => {
  try {
  const b = z.object({
    role: z.enum(["USER","AGENT","ADMIN"]),
    tier: z.enum(["USER","BASIC","SILVER","GOLD","PLATINUM"]).optional(),
  }).parse(req.body);

  const updated = await User.findByIdAndUpdate(
    req.params.id,
    { role: b.role, ...(b.tier ? { tier: b.tier } : {}) },
    { new: true }
  ).select("phone fullName role tier");

  if (!updated) return res.status(404).json({ ok: false, error: "User not found" });

  res.json({ ok: true, user: updated });
  } catch (e) {
    next(e);
  }
});
module.exports = router;
