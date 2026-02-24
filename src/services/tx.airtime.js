const Transaction = require("../models/Transaction");
const User = require("../models/User");
const { priceForTier } = require("../utils/pricing.engine");
const { buyAirtime } = require("./providers/peyflex.provider");
const { newReference } = require("./tx.utils");

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
    provider: "PEYFLEX",
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

  const providerRes = await buyAirtime(payload);

  const ok =
    providerRes?.status === "success" ||
    providerRes?.success === true ||
    String(providerRes?.message || "").toLowerCase().includes("success");

  return { ok, provider: providerRes };
}

module.exports = { createAirtimeTx, processAirtimeTx };
