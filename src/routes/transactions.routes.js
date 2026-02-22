const router = require("express").Router();
const { z } = require("zod");

const { auth } = require("../middleware/auth");
const Transaction = require("../models/Transaction");

// ✅ use the unified engine
const { createUnifiedTx } = require("../services/tx.engine");

// Create unified transaction
router.post("/create", auth, async (req, res, next) => {
  try {
    // ✅ Accept BOTH (new + old) formats
    const b = z
      .object({
        // new format
        serviceType: z.string().optional(),
        network: z.string().optional(),
        productCode: z.string().optional(),
        meta: z.any().optional(),

        // old format (backward compatible)
        type: z.string().optional(),
        amount: z.number().optional(),
      })
      .passthrough()
      .parse(req.body);

    // Normalize to new format
    const serviceType = (b.serviceType || b.type || "").toUpperCase();

    // DATA old meta supports: { network, mobile_number, plan_code }
    // New format uses: { network, productCode, meta.mobile_number }
    const normalized = {
      serviceType,
      network: b.network || b.meta?.network,
      productCode: b.productCode || b.meta?.plan_code || b.meta?.productCode,
      meta: b.meta || {},
    };

    // Ensure DATA has a recipient number if old payload used mobile_number
    if (serviceType === "DATA") {
      normalized.meta.mobile_number =
        normalized.meta.mobile_number || normalized.meta.phone || normalized.meta.recipient || b.meta?.mobile_number;
    }

    const out = await createUnifiedTx({
      userId: req.user.sub,
      body: normalized,
      headers: req.headers,
    });

    return res.json({
      ok: true,
      tx: out.tx,
      provider: out.provider,
      token: out.token,
      networkMatch: out.networkMatch,
      deduped: !!out.deduped,
    });
  } catch (e) {
    next(e);
  }
});

// List my transactions
router.get("/my", auth, async (req, res) => {
  const txs = await Transaction.find({ userId: req.user.sub })
    .sort({ createdAt: -1 })
    .limit(50);

  res.json({ ok: true, txs });
});

module.exports = router;
