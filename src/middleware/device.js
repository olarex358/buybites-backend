function requireDeviceId(req, res, next) {
  const deviceId = req.headers["x-device-id"];

  if (!deviceId || String(deviceId).trim().length < 10) {
    return res.status(400).json({
      ok: false,
      error: "Missing device id. Please refresh the app."
    });
  }

  req.deviceId = String(deviceId).trim();
  next();
}

module.exports = { requireDeviceId };
