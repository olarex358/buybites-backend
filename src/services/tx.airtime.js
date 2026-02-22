const Pricing = require("../models/Pricing");
const Transaction = require("../models/Transaction");
const User = require("../models/User");
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

  // ✅ pricing rule (if you want percentage markup later, we can extend this)
  const pricing = await Pricing.findOne({
    serviceType: "AIRTIME",
    network,
    productCode: "", // airtime has no plan_code
    isActive: true,
  });

  // Sell price = what you charge user (wallet debit)
  const sellPrice =
    Number(pricing?.prices?.[tier]) ||
    Number(pricing?.prices?.USER) ||
    amountInput;

  const baseCost = Number(pricing?.baseCost || 0);
  const profit = Math.max(0, sellPrice - baseCost);

  const reference = newReference("AT");

  const tx = await Transaction.create({
    userId,
    type: "AIRTIME",
    provider: "PEYFLEX",
    tierAtPurchase: tier,
    sellPrice,
    baseCost,
    profit,
    amount: sellPrice, // charged amount
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
