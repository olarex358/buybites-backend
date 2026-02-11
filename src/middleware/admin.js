function adminOnly(req, res, next) {
  const key = req.headers["x-admin-key"];
  const ok = key && process.env.ADMIN_KEY && key === process.env.ADMIN_KEY;

  if (!ok) return res.status(403).json({ ok: false, error: "Admin only" });
  next();
}

module.exports = { adminOnly };
