const router = require("express").Router();
const express = require("express");
const crypto = require("crypto");

const User = require("../models/User");
const WalletTx = require("../models/WalletTx");

// RAW body for signature validation
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.headers["x-paystack-signature"];
      const secret = process.env.PAYSTACK_WEBHOOK_SECRET || process.env.PAYSTACK_SECRET_KEY;

      const hash = crypto
        .createHmac("sha512", secret)
        .update(req.body)
        .digest("hex");

      if (hash !== signature) return res.sendStatus(401);

      const event = JSON.parse(req.body.toString("utf8"));
      if (event.event !== "charge.success") return res.sendStatus(200);

      const data = event.data || {};
      const ref = data.reference;
      const userId = data?.metadata?.userId;

      if (!ref || !userId) return res.sendStatus(200);

      // ✅ Only process if tx is still PENDING
      const tx = await WalletTx.findOneAndUpdate(
        { reference: ref, status: "PENDING" },
        {
          $set: {
            status: "SUCCESS",
            meta: { paystackId: data.id, channel: data.channel, paidAt: data.paid_at }
          }
        },
        { new: true }
      );

      // If tx not found OR already processed => done (idempotent)
      if (!tx) return res.sendStatus(200);

      // ✅ credit wallet using tx.amount (trusted internal amount)
      await User.findByIdAndUpdate(userId, { $inc: { walletBalance: tx.amount } });

      return res.sendStatus(200);
    } catch {
      // Always 200 to prevent Paystack retry storms
      return res.sendStatus(200);
    }
  }
);

module.exports = router;
