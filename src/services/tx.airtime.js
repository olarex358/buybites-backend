const Pricing = require("../models/Pricing");
const Transaction = require("../models/Transaction");
const User = require("../models/User");
const { buyAirtime } = require("./providers/peyflex.provider");
const { newReference } = require("./tx.utils"); // use your existing reference helper

async function createAirtimeTx({ userId, body, idempotencyKey }) {
  // body: { network, mobile_number, amount }
  const user = await User.findById(userId).select("tier");
  const tier = user?.tier || "USER";

  const network = String(body.network || "").toUpperCase().trim();
  const mobile_number = String(body.mobile_number || "").trim();
  const amountInput = Number(body.amount || 0);

  if (!network || !mobile_number || !amountInput || amountInput < 50) {
    throw new Error("Invalid airtime payload");
  }

  // manual pricing lookup ✅ (productCode can be e.g. "AIRTIME" or "")
  const pricing = await Pricing.findOne({
    serviceType: "AIRTIME",
    network,
    productCode: "", // airtime usually has no plan_code
    isActive: true,
  });

  // For airtime, sellPrice often equals amountInput (unless you want markups)
  // We still allow override if admin sets a fixed price rule.
  const sellPrice =
    Number(pricing?.prices?.[tier]) ||
    Number(pricing?.prices?.USER) ||
    amountInput;

  const baseCost = Number(pricing?.baseCost || 0);
  const profit = Math.max(0, sellPrice - baseCost);

  const reference = newReference("AT"); // or your existing generator

  // Create TX record first (PROCESSING)
  const tx = await Transaction.create({
    userId,
    type: "AIRTIME",
    provider: "PEYFLEX",
    tierAtPurchase: tier,
    sellPrice,
    baseCost,
    profit,
    amount: sellPrice,
    reference,
    idempotencyKey: idempotencyKey || "",
    status: "PROCESSING",
    meta: { network, mobile_number, requestedAmount: amountInput },
  });

  return { tx };
}

async function processAirtimeTx(tx) {
  // Call provider
  const payload = {
    network: tx.meta.network,
    phone: tx.meta.mobile_number,
    amount: tx.meta.requestedAmount, // airtime value delivered
    reference: tx.reference,
  };

  const providerRes = await buyAirtime(payload);

  // Normalize success flag — update based on your provider response format
  const isSuccess = providerRes?.status === "success" || providerRes?.success === true;

  if (isSuccess) {
    tx.status = "SUCCESS";
    tx.providerRef = providerRes?.reference || providerRes?.data?.ref || "";
    await tx.save();

    await User.findByIdAndUpdate(tx.userId, {
      $inc: { totalVolume: tx.sellPrice, totalProfit: tx.profit },
    });

    return { ok: true, tx, provider: providerRes };
  }

  tx.status = "FAILED";
  tx.lastError = providerRes?.message || "Airtime failed";
  await tx.save();

  return { ok: false, tx, provider: providerRes };
}

module.exports = { createAirtimeTx, processAirtimeTx };
