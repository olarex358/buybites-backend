const router = require("express").Router();
const { z } = require("zod");

const { auth } = require("../middleware/auth");
const User = require("../models/User");
const WalletTx = require("../models/WalletTx");
const Order = require("../models/Order");
const DataPlan = require("../models/DataPlan");

const { genRef } = require("../utils/ref");
const { cleanPhone, matchesNetwork } = require("../utils/phone");
const { peyflexClient } = require("../services/peyflex.service");
const { network, phone, planId, type } = req.body;
async function atomicDebit(userId, amount) {
  // atomic: only debit if enough balance
  return User.findOneAndUpdate(
    { _id: userId, walletBalance: { $gte: amount } },
    { $inc: { walletBalance: -amount } },
    { new: true }
  );
}
await purchaseData({
  user,
  network,
  phone,
  planId,
  type // NEW
});
async function atomicCredit(userId, amount) {
  return User.findByIdAndUpdate(userId, { $inc: { walletBalance: amount } });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

router.post("/", auth, async (req, res, next) => {
  try {
    const b = z.object({
      network: z.string().min(2),
      mobile_number: z.string().min(8),
      plan_code: z.string().min(2)
    }).parse(req.body);

    const phone11 = cleanPhone(b.mobile_number);
    if (!phone11) return res.status(400).json({ ok: false, error: "Invalid phone" });

    const networkMatch = matchesNetwork(phone11, b.network);

    const plan = await DataPlan.findOne({
      network: b.network,
      plan_code: b.plan_code,
      isActive: true
    });

    if (!plan) return res.status(400).json({ ok: false, error: "Plan not available" });

    const amount = Number(plan.sellPrice);

    // ✅ Anti double-tap: if same request exists recently, return it
    const recent = await Order.findOne({
      userId: req.user.sub,
      network: b.network,
      plan_code: b.plan_code,
      mobile_number: phone11,
      createdAt: { $gte: new Date(Date.now() - 90 * 1000) } // 90 seconds
    }).sort({ createdAt: -1 });

    if (recent && ["PROCESSING", "DELIVERED", "REFUNDED"].includes(recent.status)) {
      return res.json({ ok: true, order: recent, networkMatch, deduped: true });
    }

    const orderRef = genRef("ORD");

    // Create order first
    const order = await Order.create({
      userId: req.user.sub,
      orderRef,
      network: b.network,
      mobile_number: phone11,
      plan_code: b.plan_code,
      amount,
      status: "PROCESSING",
      retries: 0
    });

    // Debit wallet
    const debitedUser = await atomicDebit(req.user.sub, amount);
    if (!debitedUser) {
      order.status = "FAILED";
      order.lastError = "Insufficient balance";
      await order.save();
      return res.status(400).json({ ok: false, error: "Insufficient balance", networkMatch });
    }

    // Record debit tx with deterministic reference (so it can’t duplicate)
    const debitRef = `DEB_${orderRef}`;
    await WalletTx.create({
      userId: req.user.sub,
      type: "DEBIT",
      amount,
      reference: debitRef,
      status: "SUCCESS",
      meta: { orderId: String(order._id), orderRef, network: b.network, plan_code: b.plan_code, phone11, networkMatch }
    });

    // Provider call with retry x3
    const api = peyflexClient();
    let lastErr = "";
    let responseData = null;

    for (let i = 1; i <= 3; i++) {
      try {
        order.retries = i - 1;
        await order.save();

        const r = await api.post("/api/data/purchase/", {
          network: b.network,
          mobile_number: phone11,
          plan_code: b.plan_code
        });

        responseData = r.data;
        break;
      } catch (e) {
        lastErr = e?.response?.data ? JSON.stringify(e.response.data) : e.message;
        await sleep(700 * i);
      }
    }

    order.providerRef = responseData?.reference || responseData?.ref || "";

    const txt = JSON.stringify(responseData || "").toLowerCase();
    const isSuccess = responseData && (txt.includes("success") || txt.includes("delivered"));

    if (isSuccess) {
      order.status = "DELIVERED";
      await order.save();
      return res.json({ ok: true, order, networkMatch });
    }

    // ✅ Refund (idempotent): only refund once
    order.status = "REFUNDED";
    order.lastError = responseData ? "Provider failed" : (lastErr || "Provider error");
    await order.save();

    const refundRef = `CR_${orderRef}`;
    const alreadyRefunded = await WalletTx.findOne({ reference: refundRef }).select("_id");
    if (!alreadyRefunded) {
      await atomicCredit(req.user.sub, amount);

      await WalletTx.create({
        userId: req.user.sub,
        type: "CREDIT",
        amount,
        reference: refundRef,
        status: "SUCCESS",
        meta: { orderId: String(order._id), orderRef, reason: order.lastError }
      });
    }

    return res.json({ ok: true, order, networkMatch });

  } catch (e) {
    next(e);
  }
});

router.get("/my", auth, async (req, res) => {
  const orders = await Order.find({ userId: req.user.sub }).sort({ createdAt: -1 }).limit(50);
  res.json({ ok: true, orders });
});

module.exports = router;
