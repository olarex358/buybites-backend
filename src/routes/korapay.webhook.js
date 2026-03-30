// src/routes/korapay.webhook.js
// Standalone Korapay webhook handler — mounted at /api/wallet/korapay/webhook
// IMPORTANT: Must be mounted BEFORE express.json() in server.js so the raw buffer is intact.

const crypto = require("crypto");
const router = require("express").Router();

const WalletTx = require("../models/WalletTx");
const User     = require("../models/User");

const KORA_BASE      = "https://api.korapay.com/merchant/api/v1";
const KORA_SECRET    = process.env.KORAPAY_SECRET_KEY;
const WEBHOOK_SECRET = process.env.KORAPAY_WEBHOOK_SECRET;

const axios = require("axios");

async function koraVerify(reference) {
  const res = await axios.get(`${KORA_BASE}/charges/${reference}`, {
    headers: { Authorization: `Bearer ${KORA_SECRET}` },
    timeout: 10000,
  });
  return res.data;
}

router.post("/", async (req, res) => {
  try {
    // ── Verify webhook signature ──
    const signature = req.headers["x-korapay-signature"];
    if (!signature || !WEBHOOK_SECRET) {
      return res.status(400).json({ error: "Missing signature config" });
    }

    const body = req.body.toString("utf8");
    const hash = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(body)
      .digest("hex");

    if (hash !== signature) {
      console.warn("[korapay webhook] Invalid signature — ignoring");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = JSON.parse(body);
    console.log("[korapay webhook] event:", event.event, event.data?.reference);

    // Only process successful charges
    if (event.event !== "charge.success") {
      return res.status(200).json({ received: true });
    }

    const { reference, status } = event.data || {};
    if (!reference || status !== "success") {
      return res.status(200).json({ received: true });
    }

    // Find matching pending WalletTx
    const walletTx = await WalletTx.findOne({ reference, status: "PENDING" });
    if (!walletTx) {
      // Already processed or unknown — 200 to stop Korapay retrying
      return res.status(200).json({ received: true });
    }

    // Belt-and-suspenders: re-verify with Korapay API
    try {
      const verify = await koraVerify(reference);
      if (verify.data?.status !== "success") {
        console.warn("[korapay webhook] Re-verify failed:", verify.data?.status);
        return res.status(200).json({ received: true });
      }
    } catch (verifyErr) {
      console.warn("[korapay webhook] Re-verify error (continuing):", verifyErr.message);
    }

    // Atomic flip PENDING → SUCCESS (idempotent — prevents double-credit)
    const credited = await WalletTx.findOneAndUpdate(
      { _id: walletTx._id, status: "PENDING" },
      { $set: { status: "SUCCESS" } }
    );

    if (credited) {
      await User.findByIdAndUpdate(walletTx.userId, {
        $inc: { walletBalance: walletTx.amount },
      });
      console.log(`[korapay webhook] ✅ ₦${walletTx.amount} credited to user ${walletTx.userId}`);
    } else {
      console.log(`[korapay webhook] Skipped — already processed: ${reference}`);
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error("[korapay webhook] Error:", e.message);
    // Always 200 so Korapay doesn't retry indefinitely
    return res.status(200).json({ received: true });
  }
});

module.exports = router;
