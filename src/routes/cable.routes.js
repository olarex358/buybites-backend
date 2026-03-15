const express = require("express");
const router  = express.Router();

const { auth }           = require("../middleware/auth");
const { verifyCableIUC } = require("../services/providers/peyflex.provider");
const { createUnifiedTx } = require("../services/tx.engine");

// ── POST /api/cable/verify ────────────────────────────────────
// Body: { provider, smartcardNumber }
router.post("/verify", auth, async (req, res, next) => {
  try {
    const { provider, smartcardNumber } = req.body;
    if (!provider || !smartcardNumber) {
      return res.fail("provider and smartcardNumber are required", 400);
    }

    const r = await verifyCableIUC({
      provider:        String(provider).toUpperCase(),
      smartcardNumber: String(smartcardNumber).trim(),
    });

    return res.success({
      name: r.customer_name || r.name || r.full_name || "Customer",
    }, "IUC verified");
  } catch (e) {
    const msg = e?.response?.data?.message
      || e?.response?.data?.detail
      || e.message
      || "IUC verification failed";
    return res.fail(msg, 400);
  }
});

// ── POST /api/cable/buy ───────────────────────────────────────
router.post("/buy", auth, async (req, res, next) => {
  try {
    const out = await createUnifiedTx({
      userId:  req.user.sub,
      body: {
        serviceType: "CABLE",
        meta: req.body,
      },
      headers: req.headers,
    });

    return res.success(
      { tx: out.tx, provider: out.provider, deduped: !!out.deduped },
      "Cable TV recharged"
    );
  } catch (e) {
    next(e);
  }
});

module.exports = router;