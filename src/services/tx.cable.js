const Transaction = require("../models/Transaction");
const User = require("../models/User");
const { priceForTier } = require("../utils/pricing.engine");
const { verifyCableIUC, buyCable } = require("./providers/peyflex.provider");
const { newReference } = require("./tx.utils");

async function createCableTx({ userId, body, idempotencyKey }) {
  const user = await User.findById(userId).select("tier");
  const tier = user?.tier || "USER";

  const provider = String(body.provider || "").toUpperCase().trim();
  const smartcardNumber = String(body.smartcardNumber || body.iuc || "").trim();
  const planCode = String(body.planCode || body.plan_code || "").trim();
  const amountInput = Number(body.amount || 0);

  if (!provider || !smartcardNumber || !planCode) {
    const err = new Error("Invalid cable payload");
    err.status = 400;
    throw err;
  }

  const p = await priceForTier({
    serviceType: "TV",
    tier,
    network: provider,
    productCode: planCode,
    defaultSellPrice: amountInput,
    defaultBaseCost: 0,
  });

  const reference = newReference("TV");

  const tx = await Transaction.create({
    userId,
    type: "TV",
    provider: "PEYFLEX",
    tierAtPurchase: tier,
    sellPrice: p.sellPrice,
    baseCost: p.baseCost,
    profit: p.profit,
    amount: p.sellPrice,
    reference,
    idempotencyKey: idempotencyKey || "",
    status: "PROCESSING",
    meta: { provider, smartcardNumber, planCode, requestedAmount: amountInput },
  });

  return { tx };
}

async function processCableTx(tx) {
  const payload = {
    provider: tx.meta.provider,
    smartcardNumber: tx.meta.smartcardNumber,
    planCode: tx.meta.planCode,
    phone: tx.meta.phone || "07000000000", // Optional
    reference: tx.reference,
  };

  const providerRes = await buyCable(payload);

  const ok =
    providerRes?.status === "success" ||
    providerRes?.success === true ||
    String(providerRes?.message || "").toLowerCase().includes("success");

  return { ok, provider: providerRes };
}

module.exports = { createCableTx, processCableTx };
