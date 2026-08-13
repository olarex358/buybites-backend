// src/routes/auth.routes.js
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { z } = require("zod");

const User = require("../models/User");
const Transaction = require("../models/Transaction");
const { requireDeviceId } = require("../middleware/device");

const schemaLogin = z.object({ 
  phone: z.string().min(8), 
  pin: z.string().min(4).max(8) 
});


// POST /api/auth/register
router.post("/register", requireDeviceId, async (req, res, next) => {
  try {
    const fullName = String(req.body?.fullName || "").trim();
    const phone = String(req.body?.phone || "").replace(/\s+/g, "");
    const pin = String(req.body?.pin || "").replace(/\D/g, "");
    const referralCode = String(req.body?.referralCode || "").trim().toUpperCase();

    if (fullName.length < 2) {
      return res.status(400).json({ ok: false, error: "Full name is required" });
    }
    if (phone.length < 7) {
      return res.status(400).json({ ok: false, error: "Valid phone number is required" });
    }
    if (!/^\d{4,8}$/.test(pin)) {
      return res.status(400).json({ ok: false, error: "PIN must be 4-8 digits" });
    }

    const existing = await User.findOne({ phone }).select("_id");
    if (existing) {
      return res.status(409).json({ ok: false, error: "An account already exists with this phone number" });
    }

    let referrer = null;
    if (referralCode) {
      referrer = await User.findOne({ referralCode }).select("_id referralCode");
      if (!referrer) {
        return res.status(400).json({ ok: false, error: "Invalid referral code" });
      }
    }

    const pinHash = await bcrypt.hash(pin, 12);
    const user = await User.create({
      fullName,
      phone,
      pinHash,
      referredBy: referrer?.referralCode || null,
      deviceId: req.deviceId,
      deviceBoundAt: new Date(),
      lastActiveAt: new Date(),
    });

    const token = jwt.sign(
      {
        sub: user._id,
        role: user.role,
        tier: user.tier,
        referralCode: user.referralCode,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(201).json({
      ok: true,
      token,
      user: {
        _id: user._id,
        phone: user.phone,
        fullName: user.fullName,
        role: user.role,
        tier: user.tier,
        walletBalance: user.walletBalance,
        referralCode: user.referralCode,
      },
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/auth/referrals
router.get("/referrals", require("../middleware/auth").auth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.sub).select(
      "referralCode referralBonusPaid"
    );
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    const referrals = await User.find({ referredBy: user.referralCode })
      .select("fullName phone createdAt referralBonusPaid")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const referredIds = referrals.map((r) => r._id);
    const converted = referrals.filter((r) => r.referralBonusPaid).length;

    const WalletTx = require("../models/WalletTx");
    const rewardRows = await WalletTx.find({
      userId: user._id,
      type: "CREDIT",
      "meta.reward": "REFERRER_BONUS",
    }).select("amount status createdAt").lean();

    const totalBonus = rewardRows.reduce((sum, r) => sum + Number(r.amount || 0), 0);

    return res.json({
      ok: true,
      refCode: user.referralCode,
      stats: {
        totalInvited: referrals.length,
        totalConverted: converted,
        totalBonus,
        referrerBonus: Number(process.env.REFERRER_BONUS || 50),
        pendingBonus: Math.max(0, referrals.length - converted) * Number(process.env.REFERRER_BONUS || 50),
        conversionRate: referrals.length
          ? Number(((converted / referrals.length) * 100).toFixed(1))
          : 0,
      },
      referrals: referrals.map((r) => ({
        ...r,
        hasPurchased: !!r.referralBonusPaid,
      })),
    });
  } catch (e) {
    next(e);
  }
});

// ✅ POST /api/auth/login — Full Updated Version
router.post("/login", requireDeviceId, async (req, res, next) => {
  try {
    const { phone, pin } = schemaLogin.parse(req.body);
    const user = await User.findOne({ phone });

    if (!user) {
      return res.status(401).json({ ok: false, error: "Invalid phone or PIN" });
    }

    const isMatch = await bcrypt.compare(pin, user.pinHash);
    if (!isMatch) {
      return res.status(401).json({ ok: false, error: "Invalid phone or PIN" });
    }

    // --- REMOVED DEVICE BINDING BLOCK ---
    // Instead of blocking, we simply update the device info
    user.deviceId = req.deviceId;
    user.deviceBoundAt = new Date();
    user.lastActiveAt = new Date();
    await user.save();

    const token = jwt.sign(
      {
        sub: user._id,
        role: user.role,
        tier: user.tier,
        referralCode: user.referralCode,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      ok: true,
      token,
      user: {
        _id: user._id,
        phone: user.phone,
        fullName: user.fullName || "",
        role: user.role || "USER",
        tier: user.tier || "USER",
        walletBalance: user.walletBalance || 0,
        referralCode: user.referralCode || "",
      },
    });
  } catch (e) {
    next(e);
  }
});

// NOTE: Keep the rest of your routes (register, forgot-pin, etc.) as they are.
module.exports = router;