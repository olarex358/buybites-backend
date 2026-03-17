const router = require("express").Router();
const Order = require("../models/Order");
const User = require("../models/User");
const WalletTx = require("../models/WalletTx");

// Helper to refund atomic
async function atomicCredit(userId, amount) {
  return User.findByIdAndUpdate(userId, { $inc: { walletBalance: amount } });
}

// ✅ VALIDATION ROUTE (VERY IMPORTANT)
router.get("/smedata", (req, res) => {
  res.status(200).send("OK");
});

// ✅ MAIN WEBHOOK
router.post("/smedata", (req, res) => {
  // ⚡ ALWAYS RESPOND IMMEDIATELY
  res.status(200).send("OK");

  // ⚡ HANDLE LOGIC AFTER RESPONSE
  setImmediate(async () => {
    try {
      console.log("SME WEBHOOK:", req.body);

      const { code, message, data } = req.body;
      if (!data) return;

      const ref = data.reference || data.request_id; // Added safeguard in case they use request_id
      if (!ref) return;

      const order = await Order.findOne({
        $or: [{ orderRef: ref }, { providerRef: ref }]
      });

      if (!order) {
        console.log("Webhook error: Order not found for ref:", ref);
        return;
      }

      if (code === "success") {
        console.log("SME WEBHOOK SUCCESS:", data);
        if (order.status !== "PROCESSING") {
          console.log(`Order ${order.orderRef} is already ${order.status}, skipping.`);
          return;
        }

        order.status = "DELIVERED";
        order.providerRef = ref;
        await order.save();

      } else {
        console.log("SME WEBHOOK FAILED:", message);
        if (order.status !== "PROCESSING") {
          console.log(`Order ${order.orderRef} is already ${order.status}, skipping refund.`);
          return;
        }

        // Refund user
        order.status = "REFUNDED";
        order.lastError = message || "Provider failed via webhook";
        await order.save();

        const refundRef = `CR_WH_${order.orderRef}`;
        const alreadyRefunded = await WalletTx.findOne({ reference: refundRef }).select("_id");
        
        if (!alreadyRefunded) {
          await atomicCredit(order.userId, order.amount);
          
          await WalletTx.create({
            userId: order.userId,
            type: "CREDIT",
            amount: order.amount,
            reference: refundRef,
            status: "SUCCESS",
            meta: { orderId: String(order._id), orderRef: order.orderRef, reason: order.lastError }
          });
          console.log(`Refunded user ${order.userId} amount ${order.amount} for failed order ${order.orderRef}`);
        }
      }

    } catch (err) {
      console.error("Webhook error:", err);
    }
  });
});

module.exports = router;