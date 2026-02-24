// src/middleware/response.js
function response(req, res, next) {
  res.success = (data = {}, message = "OK", meta = {}) => {
    return res.status(200).json({
      success: true,
      message,
      data,
      meta,
    });
  };

  res.fail = (message = "Error", status = 400, details = null) => {
    return res.status(status).json({
      success: false,
      message,
      error: details,
    });
  };

  next();
}

module.exports = { response };