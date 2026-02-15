const router = require("express").Router();
const { z } = require("zod");

const { auth } = require("../middleware/auth");
const Transaction = require("../models/Transaction");
const { createDataTx } = require("../services/tx.engine");

// Create unified transaction
router.post("/create", auth, async (req, res, next) => {
  try {
    const b = z
      .object({
        type: z.enum(["DATA", "AIRTIME", "ELECTRICITY", "TV", "SAVINGS", "CARD", "OTHER"]),
        amount: z.number().optional(),
        meta: z.object({}).passthrough().default({}),
      })
      .parse(req.body);

    // For v1/v2 compatibility we currently implement DATA through Peyflex.
    if (b.type === "DATA") {
      const { network, mobile_number, plan_code } = b.meta;
      const out = await createDataTx({
        userId: req.user.sub,
        network,
        mobile_number,
        plan_code,
      });

      return res.json({ ok: true, tx: out.tx, networkMatch: out.networkMatch, deduped: !!out.deduped });
    }

    return res.status(501).json({ ok: false, error: "Service not enabled yet" });
  } catch (e) {
    next(e);
  }
});

// List my transactions
router.get("/my", auth, async (req, res) => {
  const txs = await Transaction.find({ userId: req.user.sub }).sort({ createdAt: -1 }).limit(50);
  res.json({ ok: true, txs });
});

module.exports = router;
