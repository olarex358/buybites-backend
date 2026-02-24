const Transaction = require("../models/Transaction");
const User = require("../models/User");
const { priceForTier } = require("../utils/pricing.engine");
const { verifyElectricity, buyElectricity } = require("./providers/peyflex.provider");
const { newReference } = require("./tx.utils");

async function verifyMeter({ disco, meterNumber, meterType }) {
  if (!disco || !meterNumber || !meterType) {
    const err = new Error("Invalid meter verify payload");
    err.status = 400;
    throw err;
  }
  return verifyElectricity({ disco, meterNumber, meterType });
}

async function createElectricityTx({ userId, body, idempotencyKey }) {
  const user = await User.findById(userId).select("tier");
  const tier = user?.tier || "USER";

  const disco = String(body.disco || body.network || "").toUpperCase().trim();
  const meterNumber = String(body.meterNumber || "").trim();
  const meterType = String(body.meterType || "").toUpperCase().trim(); // PREPAID/POSTPAID
  const phone = String(body.phone || "").trim();
  const amountInput = Number(body.amount || 0);

  if (!disco || !meterNumber || !meterType || !amountInput || amountInput < 100) {
    const err = new Error("Invalid electricity payload");
    err.status = 400;
    throw err;
  }

  const p = await priceForTier({
    serviceType: "ELECTRICITY",
    tier,
    network: disco,
    productCode: meterType,
    defaultSellPrice: amountInput,
    defaultBaseCost: 0,
  });

  const reference = newReference("EL");

  const tx = await Transaction.create({
    userId,
    type: "ELECTRICITY",
    provider: "PEYFLEX",
    tierAtPurchase: tier,
    sellPrice: p.sellPrice,
    baseCost: p.baseCost,
    profit: p.profit,
    amount: p.sellPrice,
    reference,
    idempotencyKey: idempotencyKey || "",
    status: "PROCESSING",
    meta: { disco, meterNumber, meterType, phone, requestedAmount: amountInput },
  });

  return { tx };
}

/**
 * ✅ Only calls provider and returns result.
 * Wallet debit/refund + final status are handled by tx.engine.js
 */
async function processElectricityTx(tx) {
  const payload = {
    disco: tx.meta.disco,
    meterNumber: tx.meta.meterNumber,
    meterType: tx.meta.meterType,
    amount: tx.meta.requestedAmount,
    phone: tx.meta.phone,
    reference: tx.reference,
  };

  const providerRes = await buyElectricity(payload);

  const ok =
    providerRes?.status === "success" ||
    providerRes?.success === true ||
    String(providerRes?.message || "").toLowerCase().includes("success");

  const token = providerRes?.token || providerRes?.data?.token || "";

  return { ok, provider: providerRes, token };
}

module.exports = { verifyMeter, createElectricityTx, processElectricityTx };
