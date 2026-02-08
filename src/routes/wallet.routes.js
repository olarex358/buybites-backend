const router = require("express").Router();
const { z } = require("zod");

const { auth } = require("../middleware/auth");
const User = require("../models/User");
const WalletTx = require("../models/WalletTx");
const { genRef } = require("../utils/ref");
const { paystackClient } = require("../services/paystack.service");

router.get("/balance", auth, async (req, res) => {
  const user = await User.findById(req.user.sub).select("walletBalance");
  res.json({ ok: true, walletBalance: user.walletBalance });
});

router.post("/fund/init", auth, async (req, res, next) => {
  try {
    const body = z.object({ amount: z.number().min(50) }).parse(req.body);
    const user = await User.findById(req.user.sub);
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    const ref = genRef("FUND");
    await WalletTx.create({
      userId: user._id,
      type: "FUND",
      amount: body.amount,
      reference: ref,
      status: "PENDING",
      meta: { purpose: "wallet_funding" }
    });

    const api = paystackClient();
    const kobo = Math.round(body.amount * 100);
    const r = await api.post("/transaction/initialize", {
      email: `${user.phone}@buybites.local`,
      amount: kobo,
      reference: ref,
      callback_url: `${process.env.FRONTEND_URL}/callback.html`,
      metadata: { userId: String(user._id), purpose: "wallet_funding" }
    });

    res.json({ ok: true, reference: ref, authorization_url: r.data.data.authorization_url });
  } catch (e) { next(e); }
});

router.get("/tx", auth, async (req, res) => {
  const tx = await WalletTx.find({ userId: req.user.sub }).sort({ createdAt: -1 }).limit(50);
  res.json({ ok: true, tx });
});

module.exports = router;
