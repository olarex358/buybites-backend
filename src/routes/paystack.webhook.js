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

      const data = event.data;
      const ref = data.reference;
      const userId = data?.metadata?.userId;
      if (!ref || !userId) return res.sendStatus(200);

      const tx = await WalletTx.findOne({ reference: ref });
      if (!tx) return res.sendStatus(200);
      if (tx.status === "SUCCESS") return res.sendStatus(200);

      const amountNgn = (data.amount || 0) / 100;

      // idempotent credit: mark tx success first (best effort)
      tx.status = "SUCCESS";
      tx.meta = { paystackId: data.id };
      await tx.save();

      await User.findByIdAndUpdate(userId, { $inc: { walletBalance: amountNgn } });

      return res.sendStatus(200);
    } catch {
      // Always 200 to prevent Paystack retries storm
      return res.sendStatus(200);
    }
  }
);

module.exports = router;
