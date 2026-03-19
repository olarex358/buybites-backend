const { z } = require("zod");

const User = require("../models/User");
const WalletTx = require("../models/WalletTx");
const Transaction = require("../models/Transaction");
const DataPlan = require("../models/DataPlan");

const { genRef } = require("../utils/ref");
const { cleanPhone, matchesNetwork } = require("../utils/phone");
const { peyflexClient } = require("./peyflex.service");
const { buyData: smeDataBuy } = require("./providers/smedata.provider");
const { priceForTier } = require("../utils/pricing.engine");

const { createAirtimeTx, processAirtimeTx } = require("./tx.airtime");
const { createElectricityTx, processElectricityTx } = require("./tx.electricity");
const { createCableTx, processCableTx } = require("./tx.cable");
const { createA2CTx, createExamPinTx } = require("./tx.misc");

// ---------------------- wallet atomic ops ----------------------
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

async function ledgerDebit({ userId, tx, amount }) {
  const debitRef = `DEB_${tx.reference}`;
  // deterministic reference prevents duplication
  const exists = await WalletTx.findOne({ reference: debitRef }).select("_id");
  if (exists) return;

  await WalletTx.create({
    userId,
    type: "DEBIT",
    amount,
    reference: debitRef,
    status: "SUCCESS",
    meta: { txId: String(tx._id), reference: tx.reference, type: tx.type, ...tx.meta },
  });
}

async function refundIfNeeded({ userId, tx, amount, reason }) {
  const refundRef = `CR_${tx.reference}`;
  const alreadyRefunded = await WalletTx.findOne({ reference: refundRef }).select("_id");
  if (alreadyRefunded) return;

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

function assertTransition(from, to) {
  if (from !== "PROCESSING") {
    const err = new Error(`Invalid tx transition: ${from} -> ${to}`);
    err.status = 409;
    throw err;
  }
  if (!["SUCCESS", "FAILED", "REFUNDED"].includes(to)) {
    const err = new Error(`Invalid tx status: ${to}`);
    err.status = 400;
    throw err;
  }
}

async function setFinalStatus(tx, to, { lastError = "", providerRef = "" } = {}) {
  assertTransition(tx.status, to);
  tx.status = to;
  if (lastError) tx.lastError = String(lastError);
  if (providerRef) tx.providerRef = String(providerRef);
  await tx.save();
}

// ---------------------- DATA flow ----------------------
async function createDataTx({ userId, network, mobile_number, plan_code, idempotencyKey }) {
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

  const user = await User.findById(userId).select("tier");
  const tier = user?.tier || "USER";

  const pricing = await priceForTier({
    serviceType: "DATA",
    tier,
    network: String(body.network).toUpperCase().trim(),
    productCode: String(body.plan_code).trim(),
    defaultSellPrice: Number(plan.sellPrice),
    defaultBaseCost: Number(plan.costPrice || 0),
  });

  // Anti double-tap: if same idempotencyKey exists, reuse
  if (idempotencyKey) {
    const existing = await Transaction.findOne({ userId, idempotencyKey }).sort({ createdAt: -1 });
    if (existing) return { tx: existing, networkMatch: matchesNetwork(phone11, body.network), deduped: true };
  }

  const reference = genRef("TX");
  const tx = await Transaction.create({
    userId,
    type: "DATA",
    provider: "PEYFLEX",
    tierAtPurchase: tier,
    sellPrice: pricing.sellPrice,
    baseCost: pricing.baseCost,
    profit: pricing.profit,
    amount: pricing.sellPrice,
    reference,
    idempotencyKey: idempotencyKey || "",
    status: "PROCESSING",
    meta: {
      network: body.network,
      mobile_number: phone11,
      plan_code: body.plan_code,
      planTitle: plan.title,
      networkMatch: matchesNetwork(phone11, body.network),
    },
  });

  // debit + ledger
  const debited = await atomicDebit(userId, tx.amount);
  if (!debited) {
    await setFinalStatus(tx, "FAILED", { lastError: "Insufficient balance" });
    const err = new Error("Insufficient balance");
    err.status = 400;
    throw err;
  }
  await ledgerDebit({ userId, tx, amount: tx.amount });

  // provider call with small retries
  // provider call with small retries
  const api = peyflexClient();
  let providerRes = null;
  let lastErr = "";
  const planProvider = String(plan.provider || "PEYFLEX").toUpperCase();

  for (let i = 1; i <= 3; i++) {
    try {
      tx.retries = i - 1;
      await tx.save();

      if (planProvider === "SMEDATA") {
        providerRes = await smeDataBuy({
          network: plan.peyflexNetwork || String(body.network).toLowerCase(),
          planId: String(plan.plan_code || body.plan_code).replace(/^SME_/, ""),
          phone: phone11,
          reference: tx.reference,
        });
      } else {
        const r = await api.post("/api/data/purchase/", {
          network: body.network,
          mobile_number: phone11,
          plan_code: body.plan_code,
          reference: tx.reference,
        });
        providerRes = r.data;
      }

      break;
    } catch (e) {
      lastErr = e?.response?.data ? JSON.stringify(e.response.data) : e.message;
      await new Promise((r) => setTimeout(r, 600 * i));
    }
  }
  const txt = JSON.stringify(providerRes || "").toLowerCase();
  const ok = providerRes && (txt.includes("success") || txt.includes("delivered"));
  const providerRef = providerRes?.reference || providerRes?.ref || "";

  if (ok) {
    await setFinalStatus(tx, "SUCCESS", { providerRef });
    await User.findByIdAndUpdate(userId, { $inc: { totalVolume: tx.sellPrice, totalProfit: tx.profit } });
    return { tx, provider: providerRes, networkMatch: tx.meta.networkMatch };
  }

  await setFinalStatus(tx, "REFUNDED", { lastError: providerRes ? "Provider failed" : (lastErr || "Provider error"), providerRef });
  await refundIfNeeded({ userId, tx, amount: tx.amount, reason: tx.lastError });
  return { tx, provider: providerRes, networkMatch: tx.meta.networkMatch };
}

// ---------------------- Unified entry ----------------------
/**
 * Unified entry point for ALL services
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

  const serviceType = String(payload.serviceType).toUpperCase().trim();
  const meta = payload.meta || {};

  const idempotencyKey =
    headers["x-idempotency-key"] ||
    headers["X-Idempotency-Key"] ||
    headers["x-idempotency_key"] ||
    "";

  // Fast dedupe for clients that resend requests
  if (idempotencyKey) {
    const existing = await Transaction.findOne({ userId, idempotencyKey }).sort({ createdAt: -1 });
    if (existing) return { tx: existing, provider: null, token: "", deduped: true };
  }

  if (serviceType === "DATA") {
    return createDataTx({
      userId,
      network: payload.network || meta.network,
      mobile_number: meta.mobile_number || meta.phone || meta.recipient,
      plan_code: payload.productCode || meta.plan_code || meta.productCode,
      idempotencyKey,
    });
  }

  if (serviceType === "AIRTIME") {
    const { tx } = await createAirtimeTx({ userId, body: { network: payload.network, ...meta }, idempotencyKey });

    const debited = await atomicDebit(userId, tx.amount);
    if (!debited) {
      await setFinalStatus(tx, "FAILED", { lastError: "Insufficient balance" });
      const err = new Error("Insufficient balance");
      err.status = 400;
      throw err;
    }
    await ledgerDebit({ userId, tx, amount: tx.amount });

    const result = await processAirtimeTx(tx);
    const providerRef = result.provider?.reference || result.provider?.data?.ref || "";

    if (result.ok) {
      await setFinalStatus(tx, "SUCCESS", { providerRef });
      await User.findByIdAndUpdate(userId, { $inc: { totalVolume: tx.sellPrice, totalProfit: tx.profit } });
      return { tx, provider: result.provider };
    }

    await setFinalStatus(tx, "REFUNDED", { lastError: result.provider?.message || "Airtime failed", providerRef });
    await refundIfNeeded({ userId, tx, amount: tx.amount, reason: tx.lastError });
    return { tx, provider: result.provider };
  }

  if (serviceType === "ELECTRICITY") {
    const { tx } = await createElectricityTx({ userId, body: { ...meta, network: payload.network }, idempotencyKey });

    const debited = await atomicDebit(userId, tx.amount);
    if (!debited) {
      await setFinalStatus(tx, "FAILED", { lastError: "Insufficient balance" });
      const err = new Error("Insufficient balance");
      err.status = 400;
      throw err;
    }
    await ledgerDebit({ userId, tx, amount: tx.amount });

    const result = await processElectricityTx(tx);
    const providerRef = result.provider?.reference || result.provider?.data?.ref || "";

    if (result.ok) {
      await setFinalStatus(tx, "SUCCESS", { providerRef });
      await User.findByIdAndUpdate(userId, { $inc: { totalVolume: tx.sellPrice, totalProfit: tx.profit } });
      return { tx, provider: result.provider, token: result.token || "" };
    }

    await setFinalStatus(tx, "REFUNDED", { lastError: result.provider?.message || "Electricity failed", providerRef });
    await refundIfNeeded({ userId, tx, amount: tx.amount, reason: tx.lastError });
    return { tx, provider: result.provider, token: "" };
  }

  if (serviceType === "TV" || serviceType === "CABLE") {
    const { tx } = await createCableTx({ userId, body: { ...meta, network: payload.network }, idempotencyKey });

    const debited = await atomicDebit(userId, tx.amount);
    if (!debited) {
      await setFinalStatus(tx, "FAILED", { lastError: "Insufficient balance" });
      const err = new Error("Insufficient balance");
      err.status = 400;
      throw err;
    }
    await ledgerDebit({ userId, tx, amount: tx.amount });

    const result = await processCableTx(tx);
    const providerRef = result.provider?.reference || result.provider?.data?.ref || "";

    if (result.ok) {
      await setFinalStatus(tx, "SUCCESS", { providerRef });
      await User.findByIdAndUpdate(userId, { $inc: { totalVolume: tx.sellPrice, totalProfit: tx.profit } });
      return { tx, provider: result.provider };
    }

    await setFinalStatus(tx, "REFUNDED", { lastError: result.provider?.message || "Cable TV failed", providerRef });
    await refundIfNeeded({ userId, tx, amount: tx.amount, reason: tx.lastError });
    return { tx, provider: result.provider };
  }

  if (serviceType === "AIRTIME_TO_CASH") {
    const { tx, sendTo } = await createA2CTx({ userId, body: { ...meta, network: payload.network }, idempotencyKey });
    // This is a manual review process, so we just return the tx
    return { tx, sendTo, provider: null };
  }

  if (serviceType === "EXAM_PIN" || serviceType === "EXAM") {
    const { tx } = await createExamPinTx({ userId, body: { ...meta }, idempotencyKey });
    
    // We debit the user immediately for EXAM_PIN
    const debited = await atomicDebit(userId, tx.amount);
    if (!debited) {
      await setFinalStatus(tx, "FAILED", { lastError: "Insufficient balance" });
      const err = new Error("Insufficient balance");
      err.status = 400;
      throw err;
    }
    await ledgerDebit({ userId, tx, amount: tx.amount });

    // Since EXAM_PIN is currently manual, it stays in PROCESSING
    return { tx, provider: null };
  }

  const err = new Error(`Unsupported serviceType: ${serviceType}`);
  err.status = 400;
  throw err;
}

module.exports = { createUnifiedTx };
