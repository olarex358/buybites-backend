const jwt = require("jsonwebtoken");

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: "No token" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // FIX: Reject tokens that are missing essential fields (malformed payloads)
    if (!payload.sub) {
      return res.status(401).json({ ok: false, error: "Invalid token payload" });
    }

    req.user = payload; // contains: sub, role, tier, phone, name
    next();
  } catch (err) {
    // Differentiate expired vs malformed for better debugging
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ ok: false, error: "Token expired", code: "TOKEN_EXPIRED" });
    }
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}

module.exports = { auth };
