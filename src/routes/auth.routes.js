// src/routes/auth.routes.js
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { z } = require("zod");

const User = require("../models/User");
const OtpToken = require("../models/OtpToken");

const { authLimiter } = require("../middleware/rateLimit");
const { auth } = require("../middleware/auth");
const { requireDeviceId } = require("../middleware/device");
const { sendWhatsappOtp } = require("../services/sms.service");


// ----------------- constants -----------------
const OTP_TTL_MINUTES = 5;
const OTP_COOLDOWN_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;

// ----------------- schemas -----------------
const schemaReg = z.object({ phone: z.string().min(8), pin: z.string().min(4).max(8) });
const schemaLogin = z.object({ phone: z.string().min(8), pin: z.string().min(4).max(8) });

const schemaOtpReq = z.object({
  phone: z.string().min(8),
  purpose: z.enum(["VERIFY", "RESET_PIN", "RESET_DEVICE"]),
});

const schemaOtpVerify = z.object({
  phone: z.string().min(8),
  purpose: z.enum(["VERIFY", "RESET_PIN", "RESET_DEVICE"]),
  code: z.string().min(4),
});

const schemaChangePin = z.object({
  oldPin: z.string().min(4).max(8),
  newPin: z.string().min(4).max(8),
});

const schemaForgotReq = z.object({ phone: z.string().min(8) });
const schemaForgotConfirm = z.object({
  phone: z.string().min(8),
  otp: z.string().min(4),
  newPin: z.string().min(4).max(8),
});

const schemaDeviceResetReq = z.object({ phone: z.string().min(8) });
const schemaDeviceResetConfirm = z.object({
  phone: z.string().min(8),
  otp: z.string().min(4),
});

// ----------------- helpers -----------------
function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

function normalizeNGPhone(raw) {
  let p = digitsOnly(raw).trim();

  // 080xxxxxxxx -> 23480xxxxxxxx
  if (p.startsWith("0") && p.length === 11) p = "234" + p.slice(1);
  // 234xxxxxxxxxx ok
  else if (p.startsWith("234") && p.length === 13) {
    /* ok */
  }
  // 10 digits (rare) -> assume missing leading 0, convert to 234xxxxxxxxxx
  else if (p.length === 10) p = "234" + p;

  if (!/^234\d{10}$/.test(p)) {
    const err = new Error("Invalid phone number. Use 080xxxxxxxx or +234xxxxxxxxxx");
    err.status = 400;
    throw err;
  }
  return p;
}

function validatePin(pin) {
  const p = String(pin || "").trim();
  if (!/^\d{4,8}$/.test(p)) {
    const err = new Error("PIN must be 4–8 digits");
    err.status = 400;
    throw err;
  }
  return p;
}

function sign(user) {
  if (!process.env.JWT_SECRET) {
    const err = new Error("JWT_SECRET not set");
    err.status = 500;
    throw err;
  }
  return jwt.sign(
    {
      sub: String(user._id),
      phone: user.phone,
      role: user.role,
      tier: user.tier,
      name: user.fullName || "",
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES || "7d" }
  );
}

function isLocked(user) {
  return user.lockUntil && new Date(user.lockUntil).getTime() > Date.now();
}

function lockMessage(user) {
  const ms = new Date(user.lockUntil).getTime() - Date.now();
  const mins = Math.max(1, Math.ceil(ms / 60000));
  return `Too many attempts. Try again in ${mins} minute(s).`;
}

function genOtp() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
}

async function enforceOtpCooldown(phone, purpose) {
  const last = await OtpToken.findOne({ phone, purpose }).sort({ createdAt: -1 });
  if (!last) return;

  const ageSec = Math.floor((Date.now() - new Date(last.createdAt).getTime()) / 1000);
  if (ageSec < OTP_COOLDOWN_SECONDS) {
    const retryAfter = OTP_COOLDOWN_SECONDS - ageSec;
    const err = new Error(`OTP recently sent. Try again in ${retryAfter}s`);
    err.status = 429;
    err.retryAfter = retryAfter;
    throw err;
  }
}

async function createOtp({ phone, purpose, ttlMinutes = OTP_TTL_MINUTES }) {
  await enforceOtpCooldown(phone, purpose);

  // invalidate old unused OTPs for same purpose
  await OtpToken.updateMany({ phone, purpose, used: false }, { $set: { used: true } });

  const code = genOtp();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

  await OtpToken.create({ phone, purpose, codeHash, expiresAt, attempts: 0, used: false });
  return code;
}

async function verifyOtp({ phone, purpose, code }) {
  const token = await OtpToken.findOne({ phone, purpose, used: false }).sort({ createdAt: -1 });

  if (!token) return { ok: false, error: "OTP not found or already used" };
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) {
    token.used = true;
    await token.save();
    return { ok: false, error: "OTP expired" };
  }

  if ((token.attempts || 0) >= OTP_MAX_ATTEMPTS) {
    token.used = true;
    await token.save();
    return { ok: false, error: "Too many OTP attempts. Request a new OTP." };
  }

  const match = await bcrypt.compare(String(code || "").trim(), token.codeHash);
  if (!match) {
    token.attempts = (token.attempts || 0) + 1;
    await token.save();
    return { ok: false, error: "Invalid OTP" };
  }

  token.used = true;
  await token.save();
  return { ok: true };
}

// ----------------- routes -----------------

// ✅ Register (Phone + PIN) + bind device
router.post("/register", authLimiter, requireDeviceId, async (req, res, next) => {
  try {
    const parsed = schemaReg.parse(req.body);
    const phone = normalizeNGPhone(parsed.phone);
    const pin = validatePin(parsed.pin);

    const exists = await User.findOne({ phone }).select("_id");
    if (exists) return res.status(400).json({ ok: false, error: "Phone already registered" });

    const pinHash = await bcrypt.hash(pin, 12);

    const user = await User.create({
      phone,
      pinHash,
      isVerified: false,
      failedLoginAttempts: 0,
      lockUntil: null,
      deviceId: req.deviceId,
      deviceBoundAt: new Date(),
    });

    const token = sign(user);
    return res.json({ ok: true, token, user: { id: user._id, phone: user.phone, fullName: user.fullName, role: user.role, tier: user.tier, isVerified: user.isVerified } });
  } catch (e) {
    next(e);
  }
});

// ✅ Login + lockout + device match/bind
router.post("/login", authLimiter, requireDeviceId, async (req, res, next) => {
  try {
    const parsed = schemaLogin.parse(req.body);
    const phone = normalizeNGPhone(parsed.phone);
    const pin = validatePin(parsed.pin);

    const user = await User.findOne({ phone });
    if (!user) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    if (isLocked(user)) {
      return res.status(429).json({ ok: false, error: lockMessage(user), code: "LOCKED" });
    }

    const ok = await bcrypt.compare(pin, user.pinHash);
    if (!ok) {
      user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;

      if (user.failedLoginAttempts >= 8) user.lockUntil = new Date(Date.now() + 60 * 60 * 1000);
      else if (user.failedLoginAttempts >= 5) user.lockUntil = new Date(Date.now() + 10 * 60 * 1000);

      await user.save();
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    // device binding rule
    if (!user.deviceId) {
      user.deviceId = req.deviceId;
      user.deviceBoundAt = new Date();
    } else if (user.deviceId !== req.deviceId) {
      return res.status(403).json({
        ok: false,
        error: "New device detected. Verify with OTP to continue.",
        code: "DEVICE_MISMATCH",
      });
    }

    user.failedLoginAttempts = 0;
    user.lockUntil = null;
    await user.save();

    const token = sign(user);
    return res.json({ ok: true, token, user: { id: user._id, phone: user.phone, fullName: user.fullName, role: user.role, tier: user.tier, isVerified: user.isVerified } });
  } catch (e) {
    next(e);
  }
});

// ✅ OTP request (VERIFY / RESET_PIN / RESET_DEVICE)
router.post("/otp/request", authLimiter, async (req, res, next) => {
  try {
    const parsed = schemaOtpReq.parse(req.body);
    const phone = normalizeNGPhone(parsed.phone);

    const user = await User.findOne({ phone }).select("_id");
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    const code = await createOtp({ phone, purpose: parsed.purpose, ttlMinutes: OTP_TTL_MINUTES });

    const label =
      parsed.purpose === "RESET_PIN"
        ? "PIN reset"
        : parsed.purpose === "RESET_DEVICE"
        ? "device reset"
        : "verification";

    await sendWhatsappOtp({ to: phone, otp: code });

    return res.json({ ok: true, message: "OTP sent", cooldown: OTP_COOLDOWN_SECONDS });
  } catch (e) {
    if (e.status === 429) return res.status(429).json({ ok: false, error: e.message, retryAfter: e.retryAfter });
    next(e);
  }
});

// ✅ OTP verify (VERIFY / RESET_PIN / RESET_DEVICE)
router.post("/otp/verify", authLimiter, async (req, res, next) => {
  try {
    const parsed = schemaOtpVerify.parse(req.body);
    const phone = normalizeNGPhone(parsed.phone);

    const r = await verifyOtp({ phone, purpose: parsed.purpose, code: parsed.code });
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });

    if (parsed.purpose === "VERIFY") {
      await User.updateOne({ phone }, { $set: { isVerified: true } });
    }

    return res.json({ ok: true, message: "OTP verified" });
  } catch (e) {
    next(e);
  }
});

// ✅ Change PIN (requires auth)
router.post("/pin/change", auth, async (req, res, next) => {
  try {
    const parsed = schemaChangePin.parse(req.body);
    const oldPin = validatePin(parsed.oldPin);
    const newPin = validatePin(parsed.newPin);

    if (oldPin === newPin) return res.status(400).json({ ok: false, error: "New PIN must be different" });

    const user = await User.findById(req.user.sub);
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    const ok = await bcrypt.compare(oldPin, user.pinHash);
    if (!ok) return res.status(401).json({ ok: false, error: "Invalid old PIN" });

    user.pinHash = await bcrypt.hash(newPin, 12);
    await user.save();

    return res.json({ ok: true, message: "PIN changed" });
  } catch (e) {
    next(e);
  }
});

// ✅ Forgot PIN request (wraps OTP request for RESET_PIN)
router.post("/pin/forgot/request", authLimiter, async (req, res, next) => {
  try {
    const parsed = schemaForgotReq.parse(req.body);
    const phone = normalizeNGPhone(parsed.phone);

    const user = await User.findOne({ phone }).select("_id");
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    const code = await createOtp({ phone, purpose: "RESET_PIN", ttlMinutes: OTP_TTL_MINUTES });

   await sendWhatsappOtp({ to: phone, otp: code });


    return res.json({ ok: true, message: "OTP sent", cooldown: OTP_COOLDOWN_SECONDS });
  } catch (e) {
    if (e.status === 429) return res.status(429).json({ ok: false, error: e.message, retryAfter: e.retryAfter });
    next(e);
  }
});

// ✅ Forgot PIN confirm (OTP + set new PIN + reset lock counters)
router.post("/pin/forgot/confirm", authLimiter, async (req, res, next) => {
  try {
    const parsed = schemaForgotConfirm.parse(req.body);
    const phone = normalizeNGPhone(parsed.phone);
    const newPin = validatePin(parsed.newPin);

    const r = await verifyOtp({ phone, purpose: "RESET_PIN", code: parsed.otp });
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });

    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    user.pinHash = await bcrypt.hash(newPin, 12);
    user.failedLoginAttempts = 0;
    user.lockUntil = null;
    await user.save();

    return res.json({ ok: true, message: "PIN reset successful" });
  } catch (e) {
    next(e);
  }
});

// ✅ Device reset request (OTP)
router.post("/device/reset/request", authLimiter, async (req, res, next) => {
  try {
    const parsed = schemaDeviceResetReq.parse(req.body);
    const phone = normalizeNGPhone(parsed.phone);

    const user = await User.findOne({ phone }).select("_id");
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    const code = await createOtp({ phone, purpose: "RESET_DEVICE", ttlMinutes: OTP_TTL_MINUTES });

   await sendWhatsappOtp({ to: phone, otp: code });


    return res.json({ ok: true, message: "OTP sent", cooldown: OTP_COOLDOWN_SECONDS });
  } catch (e) {
    if (e.status === 429) return res.status(429).json({ ok: false, error: e.message, retryAfter: e.retryAfter });
    next(e);
  }
});

// ✅ Device reset confirm (OTP + bind to current deviceId)
router.post("/device/reset/confirm", authLimiter, requireDeviceId, async (req, res, next) => {
  try {
    const parsed = schemaDeviceResetConfirm.parse(req.body);
    const phone = normalizeNGPhone(parsed.phone);

    const r = await verifyOtp({ phone, purpose: "RESET_DEVICE", code: parsed.otp });
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });

    const updated = await User.updateOne(
      { phone },
      {
        $set: {
          deviceId: req.deviceId,
          deviceBoundAt: new Date(),
          failedLoginAttempts: 0,
          lockUntil: null,
        },
      }
    );

    if (!updated.matchedCount) return res.status(404).json({ ok: false, error: "User not found" });

    return res.json({ ok: true, message: "Device updated. Login again." });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
