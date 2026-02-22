function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== "ADMIN") {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }
  next();
}

module.exports = { adminOnly };