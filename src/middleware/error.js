function notFound(req, res, next) {
  res.status(404);
  next(new Error(`Not Found: ${req.originalUrl}`));
}

function errorHandler(err, req, res, next) {
  const code = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;
  const message = err?.message || "Server error";

  // Prefer standardized helper when available
  if (typeof res.fail === "function") {
    return res.fail(message, code, err?.details);
  }

  return res.status(code).json({ ok: false, success: false, message, error: message });
}

module.exports = { notFound, errorHandler };
