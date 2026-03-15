const express = require("express");
const router  = express.Router();

const { auth }           = require("../middleware/auth");
const { verifyElectricity, buyElectricity } = require("../services/providers/peyflex.provider");
const { createUnifiedTx } = require("../services/tx.engine");

// ── GET /api/electricity/discos ──────────────────────────────
router.get("/discos", auth, (req, res) => {
  return res.success({
    discos: [
      { id: "IKEDC",  name: "Ikeja Electric",        state: "Lagos"     },
      { id: "EKEDC",  name: "Eko Electric",           state: "Lagos"     },
      { id: "AEDC",   name: "Abuja Electric",         state: "FCT"       },
      { id: "IBEDC",  name: "Ibadan Electric",        state: "Oyo/Osun"  },
      { id: "PHED",   name: "Port Harcourt Electric", state: "Rivers"    },
      { id: "KEDCO",  name: "Kano Electric",          state: "Kano"      },
      { id: "JED",    name: "Jos Electric",           state: "Plateau"   },
      { id: "KAEDCO", name: "Kaduna Electric",        state: "Kaduna"    },
      { id: "BEDC",   name: "Benin Electric",         state: "Edo/Delta" },
      { id: "ENDC",   name: "Enugu Electric",         state: "Enugu"     },
    ],
  }, "Discos fetched");
});

// ── POST /api/electricity/verify ─────────────────────────────
// Body: { disco, meterNumber, meterType }
// Returns: { name, address } of meter owner
router.post("/verify", auth, async (req, res, next) => {
  try {
    const { disco, meterNumber, meterType } = req.body;

    if (!disco || !meterNumber || !meterType) {
      return res.fail("disco, meterNumber and meterType are required", 400);
    }

    const r = await verifyElectricity({
      disco:       String(disco).toUpperCase(),
      meterNumber: String(meterNumber).trim(),
      meterType:   String(meterType).toUpperCase(), // PREPAID or POSTPAID
    });

    // Peyflex returns different field names — normalize them
    return res.success({
      name:    r.customer_name || r.name || r.full_name || "Customer",
      address: r.customer_address || r.address || "",
      meter:   r.meter_number || meterNumber,
    }, "Meter verified");
  } catch (e) {
    // Give a user-friendly error
    const msg = e?.response?.data?.message
      || e?.response?.data?.detail
      || e?.response?.data?.error
      || e.message
      || "Meter verification failed";
    return res.fail(msg, 400);
  }
});

// ── POST /api/electricity/buy ─────────────────────────────────
router.post("/buy", auth, async (req, res, next) => {
  try {
    const body = {
      serviceType: "ELECTRICITY",
      meta: {
        ...req.body,
        meterNumber: req.body.meterNumber || req.body.meter_number,
        meterType:   req.body.meterType   || req.body.meter_type,
        phone:       req.body.phone       || req.body.mobile_number,
      },
    };

    const out = await createUnifiedTx({
      userId:  req.user.sub,
      body,
      headers: req.headers,
    });

    return res.success(
      { tx: out.tx, provider: out.provider, token: out.token || "", deduped: !!out.deduped },
      "Electricity purchase processed"
    );
  } catch (e) {
    next(e);
  }
});

module.exports = router;