const router = require("express").Router();
const Order = require("../models/Order");
const Transaction = require("../models/Transaction");
const {
  finalizeSuccess,
  finalizeRefund,
} = require("../services/tx.lifecycle");

// Validation route
router.get("/smedata", (req, res) => {
  res.status(200).send("OK");
});

// SMEData webhook
// New NEX transactions are resolved through the unified Transaction model.
// The legacy Order fallback is kept temporarily so old BuyBites transactions
// are not abandoned during migration.
router.post("/smedata", (req, res) => {
  // Respond immediately so the provider does not wait on MongoDB work.
  res.status(200).send("OK");

  setImmediate(async () => {
    try {
      const { code, message, data } = req.body || {};
      if (!data) return;

      const ref = data.reference || data.request_id;
      if (!ref) return;

      const tx = await Transaction.findOne({
        $or: [{ reference: ref }, { providerRef: ref }],
      });

      if (tx) {
        if (tx.status !== "PROCESSING") return;

        if (code === "success") {
          await finalizeSuccess(tx, { providerRef: ref });
        } else {
          await finalizeRefund(tx, message || "Provider failed via webhook");
        }
        return;
      }

      // Legacy BuyBites Order support during migration.
      const order = await Order.findOne({
        $or: [{ orderRef: ref }, { providerRef: ref }],
      });

      if (!order || order.status !== "PROCESSING") return;

      if (code === "success") {
        order.status = "DELIVERED";
        order.providerRef = ref;
        await order.save();
      } else {
        order.status = "REFUNDED";
        order.lastError = message || "Provider failed via webhook";
        await order.save();
      }
    } catch (err) {
      console.error("[SME webhook] error:", err.message);
    }
  });
});

module.exports = router;
