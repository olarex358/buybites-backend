function adminOnly(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!process.env.ADMIN_KEY) return res.status(500).json({ ok: false, error: "ADMIN_KEY not set" });
  if (!key || key !== process.env.ADMIN_KEY) return res.status(403).json({ ok: false, error: "Admin only" });
  next();
}

module.exports = { adminOnly };
