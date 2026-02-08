function notFound(req, res, next) {
  res.status(404);
  next(new Error(`Not Found: ${req.originalUrl}`));
}

function errorHandler(err, req, res, next) {
  const code = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;
  res.status(code).json({
    ok: false,
    error: err.message || "Server error",
  });
}

module.exports = { notFound, errorHandler };
