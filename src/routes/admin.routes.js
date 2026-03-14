const router = require("express").Router();
const bcrypt = require("bcryptjs");
const User     = require("../models/User");
const DataPlan = require("../models/DataPlan");
const { auth } = require("../middleware/auth");

// ─── helpers ─────────────────────────────────────────────────────────────────

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
  if (p.startsWith("0") && p.length === 11)       p = "234" + p.slice(1);
  else if (p.startsWith("234") && p.length === 13) { /* ok */ }
  else if (p.length === 10)                         p = "234" + p;
  return p;
}

// ─── POST /api/admin/setup ────────────────────────────────────────────────────
router.post("/setup", async (req, res) => {
  try {
    if (!isAdminKey(req)) {
      return res.status(403).json({ ok: false, error: "Invalid admin key" });
    }

    const { phone: rawPhone, pin } = req.body;
    if (!rawPhone || !pin) {
      return res.status(400).json({ ok: false, error: "phone and pin are required" });
    }

    const pinStr = String(pin).replace(/\D/g, "");
    if (!/^\d{4,8}$/.test(pinStr)) {
      return res.status(400).json({ ok: false, error: "PIN must be 4-8 digits" });
    }

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

// ─── GET /api/admin/stats ─────────────────────────────────────────────────────
router.get("/stats", auth, requireAdminRole, async (req, res) => {
  try {
    const [totalUsers, totalAgents, newToday] = await Promise.all([
      User.countDocuments({ role: { $ne: "ADMIN" } }),
      User.countDocuments({ role: "AGENT" }),
      User.countDocuments({ createdAt: { $gte: new Date(Date.now() - 86400000) } }),
    ]);
    return res.json({ ok: true, stats: { totalUsers, totalAgents, newToday } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── GET /api/admin/users ─────────────────────────────────────────────────────
router.get("/users", auth, requireAdminRole, async (req, res) => {
  try {
    const { role, search, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (role) filter.role = role.toUpperCase();
    if (search) {
      filter.$or = [
        { fullName: { $regex: search, $options: "i" } },
        { phone:    { $regex: search, $options: "i" } },
      ];
    }
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

// ─── PATCH /api/admin/users/:id/role ─────────────────────────────────────────
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

// ─── PATCH /api/admin/users/:id/wallet ───────────────────────────────────────
router.patch("/users/:id/wallet", auth, requireAdminRole, async (req, res) => {
  try {
    const { amount, type = "CREDIT" } = req.body;
    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({ ok: false, error: "Valid positive amount required" });
    }
    const delta = type.toUpperCase() === "DEBIT" ? -Math.abs(Number(amount)) : Math.abs(Number(amount));
    const user = await User.findByIdAndUpdate(
      req.params.id, { $inc: { walletBalance: delta } }, { new: true }
    ).select("fullName phone walletBalance");
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });
    return res.json({
      ok: true,
      message: `${type} ₦${Number(amount).toLocaleString()} → ${user.phone}. Balance: ₦${user.walletBalance.toLocaleString()}`,
      walletBalance: user.walletBalance,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── GET /api/admin/pricing ───────────────────────────────────────────────────
//  Returns all data plans for the admin to edit prices
router.get("/pricing", auth, requireAdminRole, async (req, res) => {
  try {
    const plans = await DataPlan.find({}).sort({ network: 1, amount: 1 }).lean();

    // Shape each plan into a pricing row the AdminPricing page expects
    const items = plans.map((p) => ({
      _id:         p._id,
      serviceType: "DATA",
      network:     p.network,
      productCode: p.planId || p.identifier || p.code || "",
      baseCost:    p.providerPrice ?? p.costPrice ?? p.amount ?? 0,
      isActive:    p.isActive !== false,
      prices: {
        USER:     p.sellingPrice ?? p.price ?? p.amount ?? 0,
        BASIC:    p.sellingPrice ?? p.price ?? p.amount ?? 0,
        SILVER:   p.sellingPrice ?? p.price ?? p.amount ?? 0,
        GOLD:     p.sellingPrice ?? p.price ?? p.amount ?? 0,
        PLATINUM: p.sellingPrice ?? p.price ?? p.amount ?? 0,
      },
    }));

    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── PUT /api/admin/pricing ───────────────────────────────────────────────────
//  Update a single plan's prices
router.put("/pricing", auth, requireAdminRole, async (req, res) => {
  try {
    const { id, baseCost, isActive, prices } = req.body;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });

    const update = {};
    if (baseCost !== undefined) update.providerPrice = Number(baseCost);
    if (isActive !== undefined) update.isActive      = !!isActive;

    // Store the USER tier price as the main sellingPrice
    if (prices?.USER !== undefined) update.sellingPrice = Number(prices.USER);
    if (prices?.USER !== undefined) update.price        = Number(prices.USER);

    // Store all tier prices in a tierPrices map for future use
    if (prices) update.tierPrices = prices;

    const plan = await DataPlan.findByIdAndUpdate(id, update, { new: true }).lean();
    if (!plan) return res.status(404).json({ ok: false, error: "Plan not found" });

    return res.json({ ok: true, item: plan });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── DELETE /api/admin/pricing/:id ───────────────────────────────────────────
router.delete("/pricing/:id", auth, requireAdminRole, async (req, res) => {
  try {
    await DataPlan.findByIdAndDelete(req.params.id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;