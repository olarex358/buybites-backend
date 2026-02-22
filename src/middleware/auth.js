const jwt = require("jsonwebtoken");

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: "No token" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // should contain: sub, role, tier
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}

module.exports = { auth };