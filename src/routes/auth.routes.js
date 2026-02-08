const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { z } = require("zod");

const User = require("../models/User");
const { authLimiter } = require("../middleware/rateLimit");

const schemaReg = z.object({
  phone: z.string().min(8),
  pin: z.string().min(4).max(8),
  fullName: z.string().max(60).optional()
});

const schemaLogin = z.object({
  phone: z.string().min(8),
  pin: z.string().min(4).max(8)
});

function sign(user) {
  return jwt.sign(
    { sub: String(user._id), phone: user.phone },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES || "7d" }
  );
}

router.post("/register", authLimiter, async (req, res, next) => {
  try {
    const { phone, pin, fullName } = schemaReg.parse(req.body);
    const exists = await User.findOne({ phone });
    if (exists) return res.status(400).json({ ok: false, error: "Phone already registered" });

    const pinHash = await bcrypt.hash(pin, 12);
    const user = await User.create({ phone, pinHash, fullName: fullName || "" });

    const token = sign(user);
    res.json({ ok: true, token, user: { id: user._id, phone: user.phone, fullName: user.fullName } });
  } catch (e) { next(e); }
});

router.post("/login", authLimiter, async (req, res, next) => {
  try {
    const { phone, pin } = schemaLogin.parse(req.body);
    const user = await User.findOne({ phone });
    if (!user) return res.status(401).json({ ok: false, error: "Invalid credentials" });
    if (user.isBlocked) return res.status(403).json({ ok: false, error: "Account blocked" });

    const ok = await bcrypt.compare(pin, user.pinHash);
    if (!ok) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    const token = sign(user);
    res.json({ ok: true, token, user: { id: user._id, phone: user.phone, fullName: user.fullName } });
  } catch (e) { next(e); }
});

module.exports = router;
