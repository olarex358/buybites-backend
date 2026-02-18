const { z } = require("zod");

const User = require("../models/User");
const WalletTx = require("../models/WalletTx");
const Transaction = require("../models/Transaction");
const DataPlan = require("../models/DataPlan");

const { genRef } = require("../utils/ref");
const { cleanPhone, matchesNetwork } = require("../utils/phone");
const { peyflexClient } = require("./peyflex.service");
const Pricing = require("../models/Pricing");
const { createAirtimeTx, processAirtimeTx } = require("../services/tx.airtime");
const { createElectricityTx, processElectricityTx } = require("../services/tx.electricity");


async function atomicDebit(userId, amount) {
  return User.findOneAndUpdate(
    { _id: userId, walletBalance: { $gte: amount } },
    { $inc: { walletBalance: -amount } },
    { new: true }
  );
}

async function atomicCredit(userId, amount) {
  return User.findByIdAndUpdate(userId, { $inc: { walletBalance: amount } });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Create a unified DATA transaction (BuyBites 2.0)
 * - Dedup within 90 seconds
 * - Atomic wallet debit
 * - Provider retry
 * - Idempotent refund
 */
async function createDataTx({ userId, network, mobile_number, plan_code }) {
  const body = z
    .object({
      network: z.string().min(2),
      mobile_number: z.string().min(8),
      plan_code: z.string().min(2),
    })
    .parse({ network, mobile_number, plan_code });

  const phone11 = cleanPhone(body.mobile_number);
  if (!phone11) {
    const err = new Error("Invalid phone");
    err.status = 400;
    throw err;
  }

  const networkMatch = matchesNetwork(phone11, body.network);

  const plan = await DataPlan.findOne({
    network: body.network,
    plan_code: body.plan_code,
    isActive: true,
  });

  if (!plan) {
    const err = new Error("Plan not available");
    err.status = 400;
    throw err;
  }

    const user = await User.findById(userId).select("role tier");
  const tier = user?.tier || "USER";

  // Pricing override (manual tier pricing) ✅
  const pricing = await Pricing.findOne({
    serviceType: "DATA",
    network: body.network,
    productCode: body.plan_code,
    isActive: true,
  });

  const sellPrice =
    Number(pricing?.prices?.[tier]) ||
    Number(pricing?.prices?.USER) ||
    Number(plan.sellPrice);

  const baseCost = Number(pricing?.baseCost || plan.costPrice || 0);
  const profit = Math.max(0, sellPrice - baseCost);

  const amount = sellPrice; // keep existing logic using `amount`
if (type === "AIRTIME") {
  const { tx } = await createAirtimeTx({ userId, body: meta, idempotencyKey });
  // keep your existing debit/refund logic around this call if you already have it
  const result = await processAirtimeTx(tx);
  return res.json({ ok: true, tx: result.tx });
}

if (type === "ELECTRICITY") {
  const { tx } = await createElectricityTx({ userId, body: meta, idempotencyKey });
  const result = await processElectricityTx(tx);
  return res.json({ ok: true, tx: result.tx, token: result.provider?.token || result.provider?.data?.token });
}


  // Dedup (90s) — same as old Order logic
  const recent = await Transaction.findOne({
    userId,
    type: "DATA",
    "meta.network": body.network,
    "meta.plan_code": body.plan_code,
    "meta.mobile_number": phone11,
    createdAt: { $gte: new Date(Date.now() - 90 * 1000) },
  }).sort({ createdAt: -1 });

  if (recent && ["PROCESSING", "SUCCESS", "REFUNDED"].includes(recent.status)) {
    return { tx: recent, networkMatch, deduped: true };
  }

  const reference = genRef("TX");

    const tx = await Transaction.create({
    userId,
    type: "DATA",
    provider: "PEYFLEX",

    tierAtPurchase: tier,
    sellPrice,
    baseCost,
    profit,

    amount, // charged amount (same as sellPrice)
    reference,
  status: "PROCESSING",
    retries: 0,
    meta: {
      network: body.network,
      mobile_number: phone11,
      plan_code: body.plan_code,
      networkMatch,
      plan: {
        name: plan.name,
        size: plan.size,
        validity: plan.validity,
      },
    },
  });

  // Debit wallet
  const debited = await atomicDebit(userId, amount);
  if (!debited) {
    tx.status = "FAILED";
    tx.lastError = "Insufficient balance";
    await tx.save();

    const err = new Error("Insufficient balance");
    err.status = 400;
    err.extra = { networkMatch };
    throw err;
  }

  // Wallet debit ledger (unique ref)
  const debitRef = `DEB_${reference}`;
  await WalletTx.create({
    userId,
    type: "DEBIT",
    amount,
    reference: debitRef,
    status: "SUCCESS",
    meta: { txId: String(tx._id), reference, type: "DATA", ...tx.meta },
  });

  // Provider call with retry x3
  const api = peyflexClient();
  let lastErr = "";
  let responseData = null;

  for (let i = 1; i <= 3; i++) {
    try {
      tx.retries = i - 1;
      await tx.save();

      const r = await api.post("/api/data/purchase/", {
        network: body.network,
        mobile_number: phone11,
        plan_code: body.plan_code,
      });
      responseData = r.data;
      break;
    } catch (e) {
      lastErr = e?.response?.data ? JSON.stringify(e.response.data) : e.message;
      await sleep(700 * i);
    }
  }

  tx.providerRef = responseData?.reference || responseData?.ref || "";

  const txt = JSON.stringify(responseData || "").toLowerCase();
  const isSuccess = responseData && (txt.includes("success") || txt.includes("delivered"));

    if (isSuccess) {
    tx.status = "SUCCESS";
    await tx.save();

    // Update agent/user totals ✅ (SUCCESS only)
    await User.findByIdAndUpdate(userId, {
      $inc: { totalVolume: sellPrice, totalProfit: profit },
    });

    return { tx, networkMatch, provider: responseData };
  }


  // Refund idempotently
  tx.status = "REFUNDED";
  tx.lastError = responseData ? "Provider failed" : lastErr || "Provider error";
  await tx.save();

  const refundRef = `CR_${reference}`;
  const alreadyRefunded = await WalletTx.findOne({ reference: refundRef }).select("_id");
  if (!alreadyRefunded) {
    await atomicCredit(userId, amount);
    await WalletTx.create({
      userId,
      type: "CREDIT",
      amount,
      reference: refundRef,
      status: "SUCCESS",
      meta: { txId: String(tx._id), reference, reason: tx.lastError },
    });
  }

  return { tx, networkMatch, provider: responseData };
}

module.exports = { createDataTx };
