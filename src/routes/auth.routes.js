const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { z } = require("zod");

const User = require("../models/User");
const OtpToken = require("../models/OtpToken");
const { authLimiter } = require("../middleware/rateLimit");
const { auth } = require("../middleware/auth");
const { sendSms } = require("../services/sms.service");

const OTP_TTL_MINUTES = 5;
const OTP_COOLDOWN_SECONDS = 60;

// ===== helpers =====
function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

function normalizeNGPhone(raw) {
  let p = digitsOnly(raw).trim();
  if (p.startsWith("0") && p.length === 11) p = "234" + p.slice(1);
  else if (p.startsWith("234") && p.length === 13) { /* ok */ }
  else if (p.length === 10) p = "234" + p;

  if (!/^234\d{10}$/.test(p)) throw new Error("Invalid phone number. Use 080xxxxxxxx or +234xxxxxxxxxx");
  return p;
}

function validatePin(pin) {
  const p = String(pin || "").trim();
  if (!/^\d{4,8}$/.test(p)) throw new Error("PIN must be 4–8 digits");
  return p;
}

function sign(user) {
  return jwt.sign(
    { sub: String(user._id), phone: user.phone },
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

async function verifyAccountOtp() {
  if (!store.phone) return UI.toast("Login first");
  if (store.user?.isVerified) return UI.toast("Already verified ✅");

  // request OTP
  const ok = await UI.confirm(`Send OTP to ${store.phone}?`, "Verify Account");
  if (!ok) return;

  let cooldown = 0;

  while (true) {
    const r = await requestOtp(store.phone, "VERIFY");

    if (!r.ok) {
      if (r.retryAfter) {
        cooldown = r.retryAfter;
        UI.toast(`Wait ${cooldown}s to resend`);
      } else {
        return UI.alert(r.error || "OTP request failed", "OTP");
      }
    } else {
      cooldown = r.cooldown || 60;
      UI.toast("OTP sent ✅");
    }

    // enter code
    const form = await UI.form({
      title: "Enter OTP",
      okText: "Verify",
      fields: [{ name: "code", label: "OTP Code", placeholder: "123456", inputmode: "numeric", required: true }]
    });
    if (!form) return;

    try {
      await api("/api/auth/otp/verify", {
        method: "POST",
        body: JSON.stringify({ phone: store.phone, purpose: "VERIFY", code: form.code })
      });

      store.user = { ...(store.user || {}), isVerified: true };
      updateVerifyHint();
      UI.toast("Verified ✅");
      return;
    } catch (e) {
      const again = await UI.confirm("Wrong/expired OTP. Resend OTP?", "OTP Failed");
      if (!again) return;

      // countdown before next request (client-side too)
      for (let s = cooldown; s > 0; s--) {
        setText("verifyHint", `Resend in ${s}s…`);
        await sleep(1000);
      }
      updateVerifyHint();
    }
  }
}

// ===== schemas =====
const schemaReg = z.object({ phone: z.string().min(8), pin: z.string().min(4).max(8) });
const schemaLogin = z.object({ phone: z.string().min(8), pin: z.string().min(4).max(8) });

const schemaOtpReq = z.object({ phone: z.string().min(8), purpose: z.enum(["VERIFY", "RESET_PIN"]) });
const schemaOtpVerify = z.object({ phone: z.string().min(8), purpose: z.enum(["VERIFY", "RESET_PIN"]), code: z.string().min(4) });

const schemaChangePin = z.object({ oldPin: z.string().min(4).max(8), newPin: z.string().min(4).max(8) });
const schemaForgotReq = z.object({ phone: z.string().min(8) });
const schemaForgotConfirm = z.object({ phone: z.string().min(8), otp: z.string().min(4), newPin: z.string().min(4).max(8) });

// ✅ Register
router.post("/register", authLimiter, async (req, res, next) => {
  try {
    const parsed = schemaReg.parse(req.body);
    const phone = normalizeNGPhone(parsed.phone);
    const pin = validatePin(parsed.pin);

    const exists = await User.findOne({ phone });
    if (exists) return res.status(400).json({ ok: false, error: "Phone already registered" });

    const pinHash = await bcrypt.hash(pin, 12);

    const user = await User.create({
      phone,
      pinHash,
      isVerified: false,
      failedLoginAttempts: 0,
      lockUntil: null,
    });

    const token = sign(user);
    return res.json({ ok: true, token, user: { id: user._id, phone: user.phone, isVerified: user.isVerified } });
  } catch (e) { next(e); }
});

// ✅ Login with lockout
router.post("/login", authLimiter, async (req, res, next) => {
  try {
    const parsed = schemaLogin.parse(req.body);
    const phone = normalizeNGPhone(parsed.phone);
    const pin = validatePin(parsed.pin);

    const user = await User.findOne({ phone });
    if (!user) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    if (isLocked(user)) return res.status(429).json({ ok: false, error: lockMessage(user) });

    const ok = await bcrypt.compare(pin, user.pinHash);

    if (!ok) {
      user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
      if (user.failedLoginAttempts >= 8) user.lockUntil = new Date(Date.now() + 60 * 60 * 1000);
      else if (user.failedLoginAttempts >= 5) user.lockUntil = new Date(Date.now() + 10 * 60 * 1000);
      await user.save();
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    user.failedLoginAttempts = 0;
    user.lockUntil = null;
    await user.save();

    const token = sign(user);
    return res.json({ ok: true, token, user: { id: user._id, phone: user.phone, isVerified: user.isVerified } });
  } catch (e) { next(e); }
});

// ✅ OTP request (VERIFY / RESET_PIN)
router.post("/otp/request", authLimiter, async (req, res, next) => {
  try {
    const parsed = schemaOtpReq.parse(req.body);
    const phone = normalizeNGPhone(parsed.phone);

    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    const code = await createOtp({ phone, purpose: parsed.purpose, ttlMinutes: OTP_TTL_MINUTES });

    await sendSms({
      to: phone,
      message: `BuyBites OTP: ${code}. Expires in ${OTP_TTL_MINUTES} minutes.`,
    });

    return res.json({ ok: true, message: "OTP sent", cooldown: OTP_COOLDOWN_SECONDS });
  } catch (e) {
    if (e.status === 429) return res.status(429).json({ ok: false, error: e.message, retryAfter: e.retryAfter });
    next(e);
  }
});

// ✅ OTP verify
router.post("/otp/verify", authLimiter, async (req, res, next) => {
  try {
    const parsed = schemaOtpVerify.parse(req.body);
    const phone = normalizeNGPhone(parsed.phone);

    const r = await verifyOtp({ phone, purpose: parsed.purpose, code: parsed.code });
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });

    if (parsed.purpose === "VERIFY") await User.updateOne({ phone }, { $set: { isVerified: true } });
    return res.json({ ok: true, message: "OTP verified" });
  } catch (e) { next(e); }
});

// ✅ Change PIN
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
  } catch (e) { next(e); }
});

// ✅ Forgot PIN request
router.post("/pin/forgot/request", authLimiter, async (req, res, next) => {
  try {
    const parsed = schemaForgotReq.parse(req.body);
    const phone = normalizeNGPhone(parsed.phone);

    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    const code = await createOtp({ phone, purpose: "RESET_PIN", ttlMinutes: OTP_TTL_MINUTES });

    await sendSms({
      to: phone,
      message: `BuyBites PIN reset OTP: ${code}. Expires in ${OTP_TTL_MINUTES} minutes.`,
    });

    return res.json({ ok: true, message: "OTP sent", cooldown: OTP_COOLDOWN_SECONDS });
  } catch (e) {
    if (e.status === 429) return res.status(429).json({ ok: false, error: e.message, retryAfter: e.retryAfter });
    next(e);
  }
});

// ✅ Forgot PIN confirm
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
  } catch (e) { next(e); }
});

module.exports = router;
