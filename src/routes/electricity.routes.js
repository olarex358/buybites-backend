const express = require("express");
const router = express.Router();

const { auth } = require("../middleware/auth");
const { verifyMeter } = require("../services/tx.electricity");
const { createUnifiedTx } = require("../services/tx.engine");

router.get("/discos", auth, (req, res) => {
  res.json({
    ok: true,
    discos: ["IKEDC", "EKEDC", "AEDC", "IBEDC", "PHED", "KEDCO", "JED", "KAEDCO"],
  });
});

router.post("/verify", auth, async (req, res, next) => {
  try {
    const r = await verifyMeter(req.body);
    res.json({ ok: true, data: r });
  } catch (e) {
    next(e);
  }
});

router.post("/buy", auth, async (req, res, next) => {
  try {
    const body = {
      serviceType: "ELECTRICITY",
      meta: {
        ...req.body,
        // normalize common fields
        meterNumber: req.body.meterNumber || req.body.meter_number,
        meterType: req.body.meterType || req.body.meter_type,
        phone: req.body.phone || req.body.mobile_number,
      },
    };

    const out = await createUnifiedTx({
      userId: req.user.sub,
      body,
      headers: req.headers,
    });

    return res.json({
      ok: true,
      tx: out.tx,
      provider: out.provider,
      token: out.token || "",
      deduped: !!out.deduped,
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;