const router    = require("express").Router();
const bcrypt    = require("bcryptjs");
const User      = require("../models/User");
const DataPlan  = require("../models/DataPlan");
const Order     = require("../models/Order");
const WalletTx  = require("../models/WalletTx");
const Transaction = require("../models/Transaction");
const { auth }  = require("../middleware/auth");

function isAdminKey(req) {
  const key = req.headers["x-admin-key"];
  return key && process.env.ADMIN_KEY && key === process.env.ADMIN_KEY;
}

function requireAdminRole(req, res, next) {
  if ((req.user?.role || "").toUpperCase() !== "ADMIN") {
    return res.status(403).json({ ok: false, error: "Admin access required" });
  }
  next();
}

function normalizePhone(raw) {
  let p = String(raw || "").replace(/\D/g, "").trim();
  if (p.startsWith("0") && p.length === 11)        p = "234" + p.slice(1);
  else if (p.startsWith("234") && p.length === 13) { /* ok */ }
  else if (p.length === 10)                          p = "234" + p;
  return p;
}

// ── POST /api/admin/setup ─────────────────────────────────────
router.post("/setup", async (req, res) => {
  try {
    if (!isAdminKey(req)) return res.status(403).json({ ok: false, error: "Invalid admin key" });

    const { phone: rawPhone, pin } = req.body;
    if (!rawPhone || !pin) return res.status(400).json({ ok: false, error: "phone and pin required" });

    const pinStr = String(pin).replace(/\D/g, "");
    if (!/^\d{4,8}$/.test(pinStr)) return res.status(400).json({ ok: false, error: "PIN must be 4-8 digits" });

    const existingAdmin = await User.findOne({ role: "ADMIN" });
    if (existingAdmin) {
      return res.status(409).json({
        ok: false,
        error: "Admin already exists. Login with phone + PIN normally.",
        phone: existingAdmin.phone,
      });
    }

    const phone = normalizePhone(rawPhone);
    const existingUser = await User.findOne({ phone });

    if (existingUser) {
      existingUser.role = "ADMIN";
      await existingUser.save();
      return res.json({
        ok: true,
        message: `✅ ${phone} promoted to ADMIN. Login with your existing PIN.`,
        user: { _id: existingUser._id, phone: existingUser.phone, role: existingUser.role },
      });
    }

    const pinHash = await bcrypt.hash(pinStr, 12);
    const admin = await User.create({
      phone, pinHash, role: "ADMIN",
      walletBalance: 0, isVerified: true, failedLoginAttempts: 0,
    });

    return res.json({
      ok: true,
      message: `✅ Admin created for ${phone}. Login with phone + PIN.`,
      user: { _id: admin._id, phone: admin.phone, role: admin.role },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/stats ──────────────────────────────────────
// ✅ Returns EXACT fields AdminDashboard.jsx expects
router.get("/stats", auth, requireAdminRole, async (req, res) => {
  try {
    // FIX: Count both Order (legacy) and Transaction (new tx.engine) models together
    const [
      users, legacyOrders, txOrders, walletTx, activePlans,
      legacyDelivered, txSuccess,
      legacyProcessing, txProcessing,
      legacyFailed, txFailed,
      legacyRefunded, txRefunded,
    ] = await Promise.all([
      User.countDocuments({ role: { $ne: "ADMIN" } }),
      Order.countDocuments({}),
      Transaction.countDocuments({}),
      WalletTx.countDocuments({ type: "FUND", status: "SUCCESS" }),
      DataPlan.countDocuments({ isActive: true }),
      Order.countDocuments({ status: "DELIVERED" }),
      Transaction.countDocuments({ status: "SUCCESS" }),
      Order.countDocuments({ status: "PROCESSING" }),
      Transaction.countDocuments({ status: "PROCESSING" }),
      Order.countDocuments({ status: "FAILED" }),
      Transaction.countDocuments({ status: "FAILED" }),
      Order.countDocuments({ status: "REFUNDED" }),
      Transaction.countDocuments({ status: "REFUNDED" }),
    ]);

    return res.json({ ok: true, stats: {
      users,
      orders:     legacyOrders + txOrders,
      walletTx,
      activePlans,
      delivered:  legacyDelivered + txSuccess,
      processing: legacyProcessing + txProcessing,
      failed:     legacyFailed + txFailed,
      refunded:   legacyRefunded + txRefunded,
    }});
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/users ──────────────────────────────────────
router.get("/users", auth, requireAdminRole, async (req, res) => {
  try {
    const { role, search, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (role)   filter.role = role.toUpperCase();
    if (search) filter.$or  = [
      { fullName: { $regex: search, $options: "i" } },
      { phone:    { $regex: search, $options: "i" } },
    ];

    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .select("fullName phone role tier walletBalance createdAt isVerified")
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .lean();

    return res.json({ ok: true, total, page: Number(page), users });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PATCH /api/admin/users/:id/role ──────────────────────────
router.patch("/users/:id/role", auth, requireAdminRole, async (req, res) => {
  try {
    const { role, tier } = req.body;
    const update = {};
    if (role) update.role = role.toUpperCase();
    if (tier) update.tier = tier.toUpperCase();

    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true }).select("-pinHash");
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    return res.json({
      ok: true,
      message: `✅ ${user.phone} → ${user.role}${user.tier ? ` (${user.tier})` : ""}`,
      user,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PATCH /api/admin/users/:id/wallet ────────────────────────
router.patch("/users/:id/wallet", auth, requireAdminRole, async (req, res) => {
  try {
    const { amount, type = "CREDIT", note = "" } = req.body;
    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({ ok: false, error: "Valid positive amount required" });
    }
    const txType = type.toUpperCase() === "DEBIT" ? "DEBIT" : "CREDIT";
    const delta  = txType === "DEBIT" ? -Math.abs(Number(amount)) : Math.abs(Number(amount));

    // FIX: For DEBIT, use atomic findOneAndUpdate with balance guard to prevent going negative
    let user;
    if (txType === "DEBIT") {
      user = await User.findOneAndUpdate(
        { _id: req.params.id, walletBalance: { $gte: Math.abs(Number(amount)) } },
        { $inc: { walletBalance: delta } },
        { new: true }
      ).select("fullName phone walletBalance");
      if (!user) {
        // Check if user exists vs insufficient balance
        const exists = await User.findById(req.params.id).select("_id walletBalance");
        if (!exists) return res.status(404).json({ ok: false, error: "User not found" });
        return res.status(400).json({ ok: false, error: `Insufficient balance. Current: ₦${exists.walletBalance.toLocaleString()}` });
      }
    } else {
      user = await User.findByIdAndUpdate(
        req.params.id, { $inc: { walletBalance: delta } }, { new: true }
      ).select("fullName phone walletBalance");
      if (!user) return res.status(404).json({ ok: false, error: "User not found" });
    }

    // ✅ Audit trail: record every admin adjustment as a WalletTx
    const { genRef } = require("../utils/ref");
    await WalletTx.create({
      userId:    user._id,
      type:      txType,
      amount:    Math.abs(Number(amount)),
      reference: genRef("ADM"),
      status:    "SUCCESS",
      provider:  "ADMIN",
      meta: {
        adjustedBy: req.user.sub,
        note: note || `Admin ${txType.toLowerCase()} adjustment`,
      },
    });

    return res.json({
      ok: true,
      message: `${txType} ₦${Number(amount).toLocaleString()} → ${user.phone}. Balance: ₦${user.walletBalance.toLocaleString()}`,
      walletBalance: user.walletBalance,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/pricing ────────────────────────────────────
// ✅ Uses correct DataPlan fields: sellPrice, costPrice, plan_code
router.get("/pricing", auth, requireAdminRole, async (req, res) => {
  try {
    const plans = await DataPlan.find({}).sort({ network: 1, sellPrice: 1 }).lean();

    const items = plans.map(p => ({
      _id:         p._id,
      serviceType: "DATA",
      network:     p.network,
      productCode: p.plan_code || "",
      label:       p.title || p.plan_code || "",
      baseCost:    p.costPrice  || 0,
      isActive:    p.isActive !== false,
      prices: {
        USER:     p.sellPrice || 0,
        BASIC:    p.tierPrices?.BASIC    || p.sellPrice || 0,
        SILVER:   p.tierPrices?.SILVER   || p.sellPrice || 0,
        GOLD:     p.tierPrices?.GOLD     || p.sellPrice || 0,
        PLATINUM: p.tierPrices?.PLATINUM || p.sellPrice || 0,
      },
    }));

    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PUT /api/admin/pricing ────────────────────────────────────
// ✅ Saves to correct fields: sellPrice, costPrice
router.put("/pricing", auth, requireAdminRole, async (req, res) => {
  try {
    const { id, baseCost, isActive, prices } = req.body;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });

    const update = {};
    if (baseCost  !== undefined) update.costPrice = Number(baseCost);
    if (isActive  !== undefined) update.isActive  = !!isActive;
    if (prices?.USER !== undefined) update.sellPrice = Number(prices.USER);
    if (prices)                     update.tierPrices = prices;

    const plan = await DataPlan.findByIdAndUpdate(id, update, { new: true }).lean();
    if (!plan) return res.status(404).json({ ok: false, error: "Plan not found" });

    return res.json({ ok: true, item: plan });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── DELETE /api/admin/pricing/:id ────────────────────────────
router.delete("/pricing/:id", auth, requireAdminRole, async (req, res) => {
  try {
    await DataPlan.findByIdAndDelete(req.params.id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/manual-tx ─────────────────────────────────
router.get("/manual-tx", auth, requireAdminRole, async (req, res) => {
  try {
    const txs = await Transaction.find({
      status: "PROCESSING",
      type: { $in: ["AIRTIME_TO_CASH", "EXAM_PIN", "EXAM"] }
    }).sort({ createdAt: -1 }).populate("userId", "fullName phone walletBalance").lean();
    
    return res.json({ ok: true, txs });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/admin/manual-tx/:id/approve ─────────────────────
router.post("/manual-tx/:id/approve", auth, requireAdminRole, async (req, res) => {
  try {
    const { id } = req.params;
    const { note = "", pins = [] } = req.body;
    
    const tx = await Transaction.findById(id);
    if (!tx) return res.status(404).json({ ok: false, error: "Transaction not found" });
    if (tx.status !== "PROCESSING") return res.status(400).json({ ok: false, error: "Transaction already processed" });

    // 1. Update Transaction
    tx.status = "SUCCESS";
    tx.meta = { ...tx.meta, adminNote: note, approvedAt: new Date() };
    if (pins.length > 0) tx.meta.pins = pins;
    await tx.save();

    // 2. Logic based on type
    if (tx.type === "AIRTIME_TO_CASH") {
      // Logic: User sent us airtime, now we pay them (credit their wallet)
      const payout = tx.amount;
      const user = await User.findByIdAndUpdate(tx.userId, { $inc: { walletBalance: payout } }, { new: true });
      
      // Audit trail
      const { genRef } = require("../utils/ref");
      await WalletTx.create({
        userId: tx.userId,
        type: "CREDIT",
        amount: payout,
        reference: genRef("A2C"),
        status: "SUCCESS",
        provider: "ADMIN",
        meta: { txId: tx._id, type: "A2C_PAYOUT", note: note || "Airtime to Cash payout" }
      });
    }

    return res.json({ ok: true, message: "Transaction approved successfully" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/admin/manual-tx/:id/reject ──────────────────────
router.post("/manual-tx/:id/reject", auth, requireAdminRole, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = "" } = req.body;
    
    const tx = await Transaction.findById(id);
    if (!tx) return res.status(404).json({ ok: false, error: "Transaction not found" });
    if (tx.status !== "PROCESSING") return res.status(400).json({ ok: false, error: "Transaction already processed" });

    // 1. Update Transaction
    tx.status = "FAILED";
    tx.lastError = reason || "Rejected by admin";
    await tx.save();

    // 2. Logic based on type (Refund if needed)
    if (tx.type === "EXAM_PIN" || tx.type === "EXAM") {
      // Logic: User was already debited, now we refund
      const refundAmt = tx.amount;
      await User.findByIdAndUpdate(tx.userId, { $inc: { walletBalance: refundAmt } });
      
      const { genRef } = require("../utils/ref");
      await WalletTx.create({
        userId: tx.userId,
        type: "CREDIT",
        amount: refundAmt,
        reference: genRef("RFD"),
        status: "SUCCESS",
        provider: "ADMIN",
        meta: { txId: tx._id, reason: "Admin rejected request" }
      });
      
      tx.status = "REFUNDED";
      await tx.save();
    }

    return res.json({ ok: true, message: "Transaction rejected/refunded" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;