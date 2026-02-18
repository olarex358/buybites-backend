const Pricing = require("../models/Pricing");
const Transaction = require("../models/Transaction");
const User = require("../models/User");
const { verifyElectricity, buyElectricity } = require("./providers/peyflex.provider");
const { newReference } = require("./tx.utils");

async function verifyMeter({ disco, meterNumber, meterType }) {
  if (!disco || !meterNumber || !meterType) throw new Error("Invalid meter verify payload");
  return verifyElectricity({ disco, meterNumber, meterType });
}

async function createElectricityTx({ userId, body, idempotencyKey }) {
  // body: { disco, meterNumber, meterType, amount, phone }
  const user = await User.findById(userId).select("tier");
  const tier = user?.tier || "USER";

  const disco = String(body.disco || "").toUpperCase().trim();
  const meterNumber = String(body.meterNumber || "").trim();
  const meterType = String(body.meterType || "").toUpperCase().trim(); // PREPAID/POSTPAID
  const phone = String(body.phone || "").trim();
  const amountInput = Number(body.amount || 0);

  if (!disco || !meterNumber || !meterType || !amountInput || amountInput < 100) {
    throw new Error("Invalid electricity payload");
  }

  // manual pricing lookup ✅ (productCode can be disco+meterType if you like)
  const pricing = await Pricing.findOne({
    serviceType: "ELECTRICITY",
    network: disco,
    productCode: meterType,
    isActive: true,
  });

  const sellPrice =
    Number(pricing?.prices?.[tier]) ||
    Number(pricing?.prices?.USER) ||
    amountInput;

  const baseCost = Number(pricing?.baseCost || 0);
  const profit = Math.max(0, sellPrice - baseCost);

  const reference = newReference("EL");

  const tx = await Transaction.create({
    userId,
    type: "ELECTRICITY",
    provider: "PEYFLEX",
    tierAtPurchase: tier,
    sellPrice,
    baseCost,
    profit,
    amount: sellPrice,
    reference,
    idempotencyKey: idempotencyKey || "",
    status: "PROCESSING",
    meta: { disco, meterNumber, meterType, phone, requestedAmount: amountInput },
  });

  return { tx };
}

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
  const isSuccess = providerRes?.status === "success" || providerRes?.success === true;

  if (isSuccess) {
    tx.status = "SUCCESS";
    tx.providerRef = providerRes?.token || providerRes?.data?.token || "";
    await tx.save();

    await User.findByIdAndUpdate(tx.userId, {
      $inc: { totalVolume: tx.sellPrice, totalProfit: tx.profit },
    });

    return { ok: true, tx, provider: providerRes };
  }

  tx.status = "FAILED";
  tx.lastError = providerRes?.message || "Electricity failed";
  await tx.save();

  return { ok: false, tx, provider: providerRes };
}

module.exports = { verifyMeter, createElectricityTx, processElectricityTx };
