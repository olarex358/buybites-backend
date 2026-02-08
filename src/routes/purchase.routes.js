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

async function atomicDebit(userId, amount) {
  // atomic: only debit if enough balance
  const user = await User.findOneAndUpdate(
    { _id: userId, walletBalance: { $gte: amount } },
    { $inc: { walletBalance: -amount } },
    { new: true }
  );
  return user; // null => insufficient
}

async function credit(userId, amount) {
  await User.findByIdAndUpdate(userId, { $inc: { walletBalance: amount } });
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

    // Soft validation (warn)
    const networkMatch = matchesNetwork(phone11, b.network);

    const plan = await DataPlan.findOne({ network: b.network, plan_code: b.plan_code, isActive: true });
    if (!plan) return res.status(400).json({ ok: false, error: "Plan not available" });

    const amount = Number(plan.sellPrice);
    const ref = genRef("ORD");

    const order = await Order.create({
      userId: req.user.sub,
      network: b.network,
      mobile_number: phone11,
      plan_code: b.plan_code,
      amount,
      status: "PROCESSING"
    });

    const debitedUser = await atomicDebit(req.user.sub, amount);
    if (!debitedUser) {
      order.status = "FAILED";
      order.lastError = "Insufficient balance";
      await order.save();
      return res.status(400).json({ ok: false, error: "Insufficient balance", networkMatch });
    }

    await WalletTx.create({
      userId: req.user.sub,
      type: "DEBIT",
      amount,
      reference: ref,
      status: "SUCCESS",
      meta: { orderId: String(order._id), network: b.network, plan_code: b.plan_code, phone11, networkMatch }
    });

    // Peyflex call with retry x3
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
        await sleep(600 * i); // small backoff
      }
    }

    const txt = JSON.stringify(responseData || "").toLowerCase();
    order.providerRef = responseData?.reference || responseData?.ref || "";

    if (responseData && (txt.includes("success") || txt.includes("delivered"))) {
      order.status = "DELIVERED";
      await order.save();
      return res.json({ ok: true, order, networkMatch });
    }

    // fail => refund
    order.status = "REFUNDED";
    order.lastError = responseData ? "Provider failed" : lastErr || "Provider error";
    await order.save();

    await credit(req.user.sub, amount);
    await WalletTx.create({
      userId: req.user.sub,
      type: "CREDIT",
      amount,
      reference: `RF_${ref}`,
      status: "SUCCESS",
      meta: { orderId: String(order._id), reason: order.lastError }
    });

    return res.json({ ok: true, order, networkMatch });

  } catch (e) { next(e); }
});

router.get("/my", auth, async (req, res) => {
  const orders = await Order.find({ userId: req.user.sub }).sort({ createdAt: -1 }).limit(50);
  res.json({ ok: true, orders });
});

module.exports = router;
