const jwt = require("jsonwebtoken");
const User = require("../models/User");

async function adminOnly(req, res, next) {
  // Option 1: existing admin key (keep working ✅)
  const key = req.headers["x-admin-key"];
  if (key && process.env.ADMIN_KEY && key === process.env.ADMIN_KEY) return next();

  // Option 2: JWT + role ADMIN ✅
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!token) return res.status(403).json({ ok: false, error: "Admin only" });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.sub).select("role");
    if (!user || user.role !== "ADMIN") {
      return res.status(403).json({ ok: false, error: "Admin only" });
    }

    req.user = payload;
    return next();
  } catch {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }
}

module.exports = { adminOnly };
