const { z } = require("zod");

const User = require("../models/User");
const WalletTx = require("../models/WalletTx");
const Transaction = require("../models/Transaction");
const DataPlan = require("../models/DataPlan");
const Pricing = require("../models/Pricing");

const { genRef } = require("../utils/ref");
const { cleanPhone, matchesNetwork } = require("../utils/phone");
const { peyflexClient } = require("./peyflex.service");

const { createAirtimeTx, processAirtimeTx } = require("./tx.airtime");
const { createElectricityTx, processElectricityTx } = require("./tx.electricity");

// ---------- wallet atomic ops ----------
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
 * ✅ Unified entry point for ALL services
 * body: { serviceType, network, productCode, meta }
 */
async function createUnifiedTx({ userId, body, headers = {} }) {
  const payload = z
    .object({
      serviceType: z.string().min(2),
      network: z.string().optional(),
      productCode: z.string().optional(),
      meta: z.any().optional(),
    })
    .parse(body);

  const serviceType = String(payload.serviceType).toUpperCase();
  const network = payload.network;
  const productCode = payload.productCode;
  const meta = payload.meta || {};

  // Optional idempotency key (nice for retries)
  const idempotencyKey =
    headers["x-idempotency-key"] ||
    headers["X-Idempotency-Key"] ||
    `IDEMP_${genRef("K")}`;

  if (serviceType === "DATA") {
    // DATA expects: network + plan_code + mobile_number
    return createDataTx({
      userId,
      network,
      mobile_number: meta.mobile_number || meta.phone || meta.recipient,
      plan_code: productCode || meta.plan_code,
      idempotencyKey,
    });
  }

  // helper: create debit ledger
async function ledgerDebit({ userId, tx, amount }) {
  const debitRef = `DEB_${tx.reference}`;
  await WalletTx.create({
    userId,
    type: "DEBIT",
    amount,
    reference: debitRef,
    status: "SUCCESS",
    meta: { txId: String(tx._id), reference: tx.reference, type: tx.type, ...tx.meta },
  });
}

// helper: refund idempotently
async function refundIfNeeded({ userId, tx, amount, reason }) {
  const refundRef = `CR_${tx.reference}`;
  const alreadyRefunded = await WalletTx.findOne({ reference: refundRef }).select("_id");
  if (!alreadyRefunded) {
    await atomicCredit(userId, amount);
    await WalletTx.create({
      userId,
      type: "CREDIT",
      amount,
      reference: refundRef,
      status: "SUCCESS",
      meta: { txId: String(tx._id), reference: tx.reference, reason },
    });
  }
}

if (serviceType === "AIRTIME") {
  const { tx } = await createAirtimeTx({
    userId,
    body: { network, ...meta },
    idempotencyKey,
  });

  // ✅ debit wallet
  const debited = await atomicDebit(userId, tx.amount);
  if (!debited) {
    tx.status = "FAILED";
    tx.lastError = "Insufficient balance";
    await tx.save();
    const err = new Error("Insufficient balance");
    err.status = 400;
    throw err;
  }
  await ledgerDebit({ userId, tx, amount: tx.amount });

  const result = await processAirtimeTx(tx);

  if (result.ok) {
    tx.status = "SUCCESS";
    tx.providerRef = result.provider?.reference || result.provider?.data?.ref || "";
    await tx.save();
    await User.findByIdAndUpdate(userId, { $inc: { totalVolume: tx.sellPrice, totalProfit: tx.profit } });
    return { tx, provider: result.provider };
  }

  // ✅ refund
  tx.status = "REFUNDED";
  tx.lastError = result.provider?.message || "Airtime failed";
  await tx.save();
  await refundIfNeeded({ userId, tx, amount: tx.amount, reason: tx.lastError });

  return { tx, provider: result.provider };
}

if (serviceType === "ELECTRICITY") {
  const { tx } = await createElectricityTx({
    userId,
    body: { ...meta, network }, // meta contains disco/meterType/meterNumber etc
    idempotencyKey,
  });

  const debited = await atomicDebit(userId, tx.amount);
  if (!debited) {
    tx.status = "FAILED";
    tx.lastError = "Insufficient balance";
    await tx.save();
    const err = new Error("Insufficient balance");
    err.status = 400;
    throw err;
  }
  await ledgerDebit({ userId, tx, amount: tx.amount });

  const result = await processElectricityTx(tx);

  if (result.ok) {
    tx.status = "SUCCESS";
    tx.providerRef = result.token || "";
    await tx.save();
    await User.findByIdAndUpdate(userId, { $inc: { totalVolume: tx.sellPrice, totalProfit: tx.profit } });
    return { tx, provider: result.provider, token: result.token };
  }

  tx.status = "REFUNDED";
  tx.lastError = result.provider?.message || "Electricity failed";
  await tx.save();
  await refundIfNeeded({ userId, tx, amount: tx.amount, reason: tx.lastError });

  return { tx, provider: result.provider };
}
const err = new Error(`Unsupported serviceType: ${serviceType}`);
  err.status = 400;
  throw err;
}

/**
 * ✅ Your existing DATA flow (clean + stable)
 * - dedup within 90s
 * - tier pricing override
 * - atomic debit + ledger
 * - provider retry
 * - idempotent refund
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

  // Tier pricing override ✅
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
  const amount = sellPrice;

  // Dedup (90s)
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

    amount,
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

  // Ledger debit
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

module.exports = { createUnifiedTx, createDataTx };
