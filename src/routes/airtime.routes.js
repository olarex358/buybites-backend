const express = require("express");
const router = express.Router();

const { auth } = require("../middleware/auth");
const { createUnifiedTx } = require("../services/tx.engine");

router.get("/providers", auth, (req, res) => {
  return res.success({ providers: ["MTN", "GLO", "AIRTEL", "9MOBILE"] }, "Providers fetched");
});

router.post("/buy", auth, async (req, res, next) => {
  try {
    const body = {
      serviceType: "AIRTIME",
      network: req.body.network,
      meta: {
        ...req.body,
        // support common field names
        mobile_number: req.body.mobile_number || req.body.phone || req.body.recipient,
      },
    };

    const out = await createUnifiedTx({
      userId: req.user.sub,
      body,
      headers: req.headers,
    });

    return res.success(
      { tx: out.tx, provider: out.provider, deduped: !!out.deduped },
      "Airtime purchase processed"
    );
  } catch (e) {
    next(e);
  }
});

module.exports = router;