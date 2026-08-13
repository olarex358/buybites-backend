// src/middleware/device.js
function requireDeviceId(req, res, next) {
  // Check for the header, but provide a "web-session" fallback if missing
  const deviceId = req.headers["x-device-id"] || "web-session";

  // We attach it to the request so downstream functions don't crash,
  // but we no longer validate the length or existence.
  req.deviceId = String(deviceId).trim();
  
  next();
}

module.exports = { requireDeviceId };