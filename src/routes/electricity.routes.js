const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const { verifyMeter } = require("../services/tx.electricity");
const txController = require("../controllers/tx.controller");

router.get("/discos", protect, (req, res) => {
  res.json({ ok: true, discos: ["IKEDC", "EKEDC", "AEDC", "IBEDC", "PHED", "KEDCO", "JED", "KAEDCO"] });
});

router.post("/verify", protect, async (req, res, next) => {
  try {
    const r = await verifyMeter(req.body);
    res.json({ ok: true, data: r });
  } catch (e) {
    next(e);
  }
});

router.post("/buy", protect, async (req, res, next) => {
  try {
    req.body = {
      type: "ELECTRICITY",
      meta: req.body, // { disco, meterNumber, meterType, amount, phone }
    };
    return txController.createTx(req, res, next);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
