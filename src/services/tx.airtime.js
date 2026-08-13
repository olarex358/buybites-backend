const Transaction = require("../models/Transaction");
const User = require("../models/User");
const { priceForTier } = require("../utils/pricing.engine");
const { getProvider } = require("./provider.registry");
const { newReference } = require("./tx.utils");
const { recommend } = require("./provider.router");

async function createAirtimeTx({ userId, body, idempotencyKey }) {
  // body can be: { network, mobile_number, amount } OR { network, phone, amount }
  const user = await User.findById(userId).select("tier");
  const tier = user?.tier || "USER";

  const network = String(body.network || "").toUpperCase().trim();
  const mobile_number = String(body.mobile_number || body.phone || "").trim();
  const amountInput = Number(body.amount || 0);

  if (!network || !mobile_number || !amountInput || amountInput < 50) {
    const err = new Error("Invalid airtime payload");
    err.status = 400;
    throw err;
  }

  const route = await recommend({ service: "AIRTIME" });
  const selectedProvider = route?.provider || "PEYFLEX";

  const p = await priceForTier({
    serviceType: "AIRTIME",
    tier,
    network,
    productCode: "",
    defaultSellPrice: amountInput,
    defaultBaseCost: 0,
  });

  const reference = newReference("AT");

  const tx = await Transaction.create({
    userId,
    type: "AIRTIME",
    provider: selectedProvider,
    tierAtPurchase: tier,
    sellPrice: p.sellPrice,
    baseCost: p.baseCost,
    profit: p.profit,
    amount: p.sellPrice, // charged amount
    reference,
    idempotencyKey: idempotencyKey || "",
    status: "PROCESSING",
    meta: { network, mobile_number, requestedAmount: amountInput },
  });

  return { tx };
}

/**
 * ✅ Only calls provider and returns result.
 * Wallet debit/refund + final status are handled by tx.engine.js
 */
async function processAirtimeTx(tx) {
  const payload = {
    network: tx.meta.network,
    phone: tx.meta.mobile_number,
    amount: tx.meta.requestedAmount, // value delivered
    reference: tx.reference,
  };

  const adapter = getProvider(tx.provider || "PEYFLEX", "AIRTIME");
  if (!adapter) {
    const err = new Error("No active airtime provider is configured.");
    err.code = "NO_PROVIDER";
    throw err;
  }
  const wrapped = await adapter.airtime(payload);
  const providerRes = wrapped.data;

  const ok =
    providerRes?.status === "success" ||
    providerRes?.success === true ||
    String(providerRes?.message || "").toLowerCase().includes("success");

  return { ok, provider: providerRes, providerMeta: wrapped.providerMeta };
}

module.exports = { createAirtimeTx, processAirtimeTx };
