const express  = require("express");
const crypto   = require("crypto");
const axios    = require("axios");
const router   = express.Router();

const { auth } = require("../middleware/auth");
const WalletTx    = require("../models/WalletTx");   // adjust path if needed
const User        = require("../models/User");         // adjust path if needed

// ─────────────────────────────────────────────
//  KORAPAY CONFIG
//  Add these to your .env:
//    KORAPAY_PUBLIC_KEY=pk_live_xxxx
//    KORAPAY_SECRET_KEY=sk_live_xxxx
//    KORAPAY_WEBHOOK_SECRET=your_webhook_hash_secret
//    FRONTEND_URL=https://your-frontend.com
// ─────────────────────────────────────────────
const KORA_BASE       = "https://api.korapay.com/merchant/api/v1";
const KORA_SECRET     = process.env.KORAPAY_SECRET_KEY;
const KORA_PUBLIC     = process.env.KORAPAY_PUBLIC_KEY;
const WEBHOOK_SECRET  = process.env.KORAPAY_WEBHOOK_SECRET;
const FRONTEND_URL    = process.env.FRONTEND_URL || "http://localhost:5173";

// Korapay API helper
async function koraRequest(method, path, data = null) {
  const res = await axios({
    method,
    url: `${KORA_BASE}${path}`,
    headers: {
      Authorization: `Bearer ${KORA_SECRET}`,
      "Content-Type": "application/json",
    },
    data,
  });
  return res.data;
}

// ─────────────────────────────────────────────
//  GET /api/wallet/balance
// ─────────────────────────────────────────────
router.get("/balance", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.sub).select("walletBalance");
    res.success({ walletBalance: user?.walletBalance ?? 0 });
  } catch (e) {
    res.fail(e.message || "Could not fetch balance", 500);
  }
});

// ─────────────────────────────────────────────
//  POST /api/wallet/fund/init
//  Body: { amount: Number }
//  Returns: { checkout_url, reference, public_key }
// ─────────────────────────────────────────────
router.post("/fund/init", auth, async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!amount || amount < 100) {
      return res.fail("Minimum funding amount is ₦100", 400);
    }
    if (amount > 5_000_000) {
      return res.fail("Maximum funding amount is ₦5,000,000", 400);
    }

    const user      = await User.findById(req.user.sub).select("phone fullName email");
    const reference = `BB_FUND_${Date.now()}_${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

    // Create Korapay checkout charge
    const response = await koraRequest("POST", "/charges/initialize", {
      reference,
      amount,           // in Naira (NOT kobo — Korapay uses Naira)
      currency: "NGN",
      narration: `BuyBites wallet funding - ${user.phone}`,
      notification_url: `${process.env.BACKEND_URL || "https://buybites-backend.onrender.com"}/api/wallet/korapay/webhook`,
      redirect_url:     `${FRONTEND_URL}/callback?ref=${reference}`,
      customer: {
        name:  user.fullName || user.phone,
        email: user.email    || `${user.phone}@buybites.app`, // Korapay requires email
      },
      channels: ["card", "bank_transfer"],  // allow card + bank transfer
      metadata: {
        userId:    String(user._id),
        phone:     user.phone,
        reference,
      },
    });

    if (!response.data?.checkout_url) {
      throw new Error("Korapay did not return a checkout URL");
    }

    // Save pending WalletTx so we can match on webhook
    await WalletTx.create({
      userId:    user._id,
      type:      "FUND",
      amount,
      reference,
      status:    "PENDING",
      provider:  "KORAPAY",
      meta:      { checkout_url: response.data.checkout_url },
    });

    res.success({
      checkout_url: response.data.checkout_url,   // frontend redirects here
      reference,
      public_key: KORA_PUBLIC,
    });
  } catch (e) {
    console.error("[wallet/fund/init]", e?.response?.data || e.message);
    res.fail(e?.response?.data?.message || e.message || "Failed to initialize payment", 500);
  }
});

// ─────────────────────────────────────────────
//  POST /api/wallet/korapay/webhook
//  Korapay sends charge.success or charge.failed events here
// ─────────────────────────────────────────────
router.post("/korapay/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    // ── Verify webhook signature ──
    const signature = req.headers["x-korapay-signature"];
    if (!signature || !WEBHOOK_SECRET) {
      return res.status(400).json({ error: "Missing signature" });
    }

    const body    = req.body.toString("utf8");
    const hash    = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(body)
      .digest("hex");

    if (hash !== signature) {
      console.warn("[korapay webhook] Invalid signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = JSON.parse(body);
    console.log("[korapay webhook] event:", event.event, event.data?.reference);

    // ── Only process successful charges ──
    if (event.event !== "charge.success") {
      return res.status(200).json({ received: true });
    }

    const { reference, amount, status } = event.data || {};
    if (!reference || status !== "success") {
      return res.status(200).json({ received: true });
    }

    // ── Find matching WalletTx ──
    const walletTx = await WalletTx.findOne({ reference, status: "PENDING" });
    if (!walletTx) {
      // Already processed or doesn't exist — return 200 so Kora stops retrying
      return res.status(200).json({ received: true });
    }

    // ── Optional: re-verify with Korapay API (belt + suspenders) ──
    try {
      const verify = await koraRequest("GET", `/charges/${reference}`);
      if (verify.data?.status !== "success") {
        console.warn("[korapay webhook] Re-verify failed:", verify.data?.status);
        return res.status(200).json({ received: true });
      }
    } catch (verifyErr) {
      console.warn("[korapay webhook] Re-verify error:", verifyErr.message);
      // Still continue — we trust the signed webhook
    }

    // ── Credit wallet (atomic to prevent double-credit if verify also fires) ──
    // Only credit if WalletTx is still PENDING — idempotent guard
    const credited = await WalletTx.findOneAndUpdate(
      { _id: walletTx._id, status: "PENDING" },
      { $set: { status: "SUCCESS" } }
    );

    if (credited) {
      await User.findByIdAndUpdate(walletTx.userId, {
        $inc: { walletBalance: walletTx.amount },
      });
      console.log(`[korapay webhook] ₦${walletTx.amount} credited to user ${walletTx.userId}`);
    } else {
      console.log(`[korapay webhook] Skipped — already processed: ${reference}`);
    }

    return res.status(200).json({ received: true });

  } catch (e) {
    console.error("[korapay webhook] Error:", e.message);
    // Always return 200 to Korapay so they don't retry indefinitely
    return res.status(200).json({ received: true });
  }
});

// ─────────────────────────────────────────────
//  GET /api/wallet/verify/:reference
//  Frontend polls this after returning from checkout
//  to confirm if payment went through
// ─────────────────────────────────────────────
router.get("/verify/:reference", auth, async (req, res) => {
  try {
    const { reference } = req.params;

    const walletTx = await WalletTx.findOne({ reference, userId: req.user.sub });

    if (!walletTx) {
      return res.fail("Transaction not found", 404);
    }

    // If still pending, check with Korapay directly
    if (walletTx.status === "PENDING") {
      try {
        const verify = await koraRequest("GET", `/charges/${reference}`);
        if (verify.data?.status === "success") {
          // ✅ Atomic flip: only credit if we actually changed PENDING → SUCCESS
          // Prevents double-credit if webhook fires simultaneously
          const credited = await WalletTx.findOneAndUpdate(
            { _id: walletTx._id, status: "PENDING" },
            { $set: { status: "SUCCESS" } }
          );
          if (credited) {
            await User.findByIdAndUpdate(req.user.sub, {
              $inc: { walletBalance: walletTx.amount },
            });
          }
        }
      } catch {
        // Korapay may not have it yet — leave as PENDING
      }
    }

    const user = await User.findById(req.user.sub).select("walletBalance");

    res.success({
      status:        walletTx.status,
      amount:        walletTx.amount,
      reference:     walletTx.reference,
      walletBalance: user?.walletBalance ?? 0,
    });
  } catch (e) {
    res.fail(e.message || "Verification failed", 500);
  }
});

module.exports = router;
