const { z } = require("zod");

const User = require("../models/User");
const Transaction = require("../models/Transaction");
const DataPlan = require("../models/DataPlan");

const { genRef } = require("../utils/ref");
const { cleanPhone, matchesNetwork } = require("../utils/phone");
const { peyflexData, smedataData } = require("./providers/data.adapter");
const { priceForTier } = require("../utils/pricing.engine");

const { createAirtimeTx } = require("./tx.airtime");
const { createElectricityTx } = require("./tx.electricity");
const { createCableTx } = require("./tx.cable");
const { createA2CTx, createExamPinTx } = require("./tx.misc");
const { atomicDebit, ledgerDebit } = require("./tx.lifecycle");
const { recordTransactionEvent } = require("./tx.events");

// ---------------------- DATA creation ----------------------

/**
 * Creates a DATA transaction.
 *
 * Important:
 * - Customer-facing price comes from priceForTier().
 * - Provider cost remains separate.
 * - Campaign discounts affect the customer transaction amount.
 * - Peyflex receives the provider plan/network information,
 *   NOT the customer's discounted selling price.
 */
async function createDataTx({
  userId,
  network,
  mobile_number,
  plan_code,
  idempotencyKey,
}) {
  const body = z
    .object({
      network: z.string().min(2),
      mobile_number: z.string().min(8),
      plan_code: z.string().min(2),
    })
    .parse({
      network,
      mobile_number,
      plan_code,
    });

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

  /*
   * Customer pricing is calculated here.
   *
   * This is where campaign/tier pricing can affect what
   * the customer pays.
   */
  const pricing = await priceForTier({
    serviceType: "DATA",
    tier,
    network: String(body.network).toUpperCase().trim(),
    productCode: String(body.plan_code).trim(),

    defaultSellPrice: Number(plan.sellPrice),

    defaultBaseCost: Number(plan.costPrice || 0),

    defaultTierPrices: {
      USER: Number(plan.tierPrices?.USER || plan.sellPrice || 0),
      BASIC: Number(plan.tierPrices?.BASIC || plan.sellPrice || 0),
      SILVER: Number(plan.tierPrices?.SILVER || plan.sellPrice || 0),
      GOLD: Number(plan.tierPrices?.GOLD || plan.sellPrice || 0),
      PLATINUM: Number(
        plan.tierPrices?.PLATINUM || plan.sellPrice || 0
      ),
    },
  });

  // Idempotency protection.
  if (idempotencyKey) {
    const existing = await Transaction.findOne({
      userId,
      idempotencyKey,
    }).sort({ createdAt: -1 });

    if (existing) {
      return {
        tx: existing,
        networkMatch: matchesNetwork(phone11, body.network),
        deduped: true,
      };
    }
  }

  const planProvider = String(
    plan.provider || "PEYFLEX"
  ).toUpperCase();

  const reference = genRef("TX");

  /*
   * IMPORTANT:
   *
   * plan.peyflexNetwork is the provider-specific network identifier.
   *
   * Example:
   * MTN -> mtn_gifting_data
   * MTN -> mtn_data_share
   *
   * We store it in transaction metadata so the background processor
   * can use the correct provider value later.
   */
  const peyflexNetwork =
    plan.peyflexNetwork ||
    String(body.network).toLowerCase().trim();

  const tx = await Transaction.create({
    userId,

    type: "DATA",

    provider: planProvider,

    tierAtPurchase: tier,

    // Customer pricing
    sellPrice: pricing.sellPrice,

    // Provider/base cost
    baseCost: pricing.baseCost,

    // Profit based on customer price vs base cost
    profit: pricing.profit,

    // Amount actually debited from customer's wallet
    amount: pricing.sellPrice,

    reference,

    idempotencyKey: idempotencyKey || "",

    status: "PROCESSING",

    processingStage: "CREATED",

    statusMessage:
      "Your data purchase has been received and is being processed.",

    meta: {
      network: body.network,

      mobile_number: phone11,

      plan_code: body.plan_code,

      planTitle: plan.title,

      planProvider,

      pricingSource: pricing.pricingSource,

      pricingMode: pricing.pricingMode,

      marginPercent: pricing.marginPercent,

      /*
       * Provider-specific network.
       *
       * This must be used when sending the transaction
       * to Peyflex.
       */
      peyflexNetwork,

      networkMatch: matchesNetwork(
        phone11,
        body.network
      ),
    },
  });

  // Debit the customer's wallet using the customer price.
  const debited = await atomicDebit(
    userId,
    tx.amount
  );

  if (!debited) {
    tx.status = "FAILED";
    tx.processingStage = "FAILED";

    tx.statusMessage =
      "Insufficient wallet balance.";

    tx.lastError =
      "Insufficient balance";

    tx.completedAt = new Date();

    await tx.save();

    await recordTransactionEvent(tx, {
      status: "FAILED",
      processingStage: "FAILED",
      message: tx.statusMessage,
      source: "SYSTEM",
    });

    const err = new Error(
      "Insufficient balance"
    );

    err.status = 400;

    throw err;
  }

  await ledgerDebit({
    userId,
    tx,
    amount: tx.amount,
  });

  await recordTransactionEvent(tx, {
    status: "PROCESSING",
    processingStage: "CREATED",
    message: tx.statusMessage,
    source: "SYSTEM",
  });

  return {
    tx,
    networkMatch: tx.meta.networkMatch,
  };
}

// ---------------------- DATA provider processing ----------------------

/**
 * Processes a previously-created DATA transaction.
 *
 * IMPORTANT:
 *
 * tx.meta.network
 *     = customer's normal network identifier, e.g. "MTN"
 *
 * tx.meta.peyflexNetwork
 *     = provider-specific Peyflex identifier,
 *       e.g. "mtn_gifting_data"
 *
 * Peyflex MUST receive tx.meta.peyflexNetwork.
 */
async function processDataTx(tx) {
  const network = tx.meta?.network;

  const phone = tx.meta?.mobile_number;

  const planCode = tx.meta?.plan_code;

  const provider = String(
    tx.provider ||
      tx.meta?.planProvider ||
      "PEYFLEX"
  ).toUpperCase();

  /*
   * This is the important correction.
   *
   * Use the provider-specific network saved when
   * the transaction was created.
   *
   * Fallback is retained for older transactions that
   * may not have peyflexNetwork stored.
   */
  const peyflexNetwork =
    tx.meta?.peyflexNetwork ||
    String(network || "").toLowerCase().trim();

  let providerRes;

  let providerMeta = {};

  // ---------------------- SME DATA ----------------------

  if (provider === "SMEDATA") {
    const wrapped = await smedataData({
      network:
        tx.meta?.peyflexNetwork ||
        String(network || "").toLowerCase(),

      planId: String(planCode || "")
        .replace(/^SME_/, ""),

      phone,

      reference: tx.reference,
    });

    providerRes = wrapped.data;

    providerMeta = wrapped.providerMeta;

  // ---------------------- PEYFLEX DATA ----------------------

  } else {
    const wrapped = await peyflexData({
      /*
       * FIX:
       *
       * Previously this was:
       *
       * network
       *
       * which could send "MTN".
       *
       * Peyflex needs the provider-specific value:
       *
       * mtn_gifting_data
       * mtn_data_share
       */
      network: peyflexNetwork,

      mobile_number: phone,

      plan_code: planCode,

      reference: tx.reference,
    });

    providerRes = wrapped.data;
    

    providerMeta = wrapped.providerMeta;
    console.log(
  "[PEYFLEX DATA RESPONSE]",
  JSON.stringify(providerRes, null, 2)
);
  }

  /*
   * Normalize provider success detection.
   */
  const txt = JSON.stringify(
    providerRes || ""
  ).toLowerCase();

  const ok =
    providerRes &&
    (
      providerRes.success === true ||
      providerRes.status === "success" ||
      txt.includes("success") ||
      txt.includes("delivered")
    );

  return {
    ok,

    provider: providerRes,

    providerMeta,
  };
}

// ---------------------- Unified creation entry ----------------------

/**
 * Creates and funds a transaction quickly.
 *
 * Provider processing is deliberately moved to tx.processor.js
 * so the API doesn't hold the user's request open while
 * Peyflex/other providers respond.
 */
async function createUnifiedTx({
  userId,
  body,
  headers = {},
}) {
  const payload = z
    .object({
      serviceType: z.string().min(2),

      network: z.string().optional(),

      productCode: z.string().optional(),

      meta: z.any().optional(),
    })
    .parse(body);

  const serviceType =
    String(payload.serviceType)
      .toUpperCase()
      .trim();

  const meta = payload.meta || {};

  const idempotencyKey =
    headers["x-idempotency-key"] ||
    headers["X-Idempotency-Key"] ||
    headers["x-idempotency_key"] ||
    "";

  if (idempotencyKey) {
    const existing = await Transaction.findOne({
      userId,
      idempotencyKey,
    }).sort({ createdAt: -1 });

    if (existing) {
      return {
        tx: existing,
        provider: null,
        token: "",
        deduped: true,
      };
    }
  }

  // ---------------------- DATA ----------------------

  if (serviceType === "DATA") {
    return createDataTx({
      userId,

      network:
        payload.network ||
        meta.network,

      mobile_number:
        meta.mobile_number ||
        meta.phone ||
        meta.recipient,

      plan_code:
        payload.productCode ||
        meta.plan_code ||
        meta.productCode,

      idempotencyKey,
    });
  }

  // ---------------------- AIRTIME ----------------------

  if (serviceType === "AIRTIME") {
    const { tx } = await createAirtimeTx({
      userId,

      body: {
        network: payload.network,
        ...meta,
      },

      idempotencyKey,
    });

    const debited = await atomicDebit(
      userId,
      tx.amount
    );

    if (!debited) {
      tx.status = "FAILED";
      tx.processingStage = "FAILED";

      tx.statusMessage =
        "Insufficient wallet balance.";

      tx.lastError =
        "Insufficient balance";

      tx.completedAt = new Date();

      await tx.save();

      const err = new Error(
        "Insufficient balance"
      );

      err.status = 400;

      throw err;
    }

    await ledgerDebit({
      userId,
      tx,
      amount: tx.amount,
    });

    await recordTransactionEvent(tx, {
      status: "PROCESSING",
      processingStage: "CREATED",
      message: tx.statusMessage,
      source: "SYSTEM",
    });

    return {
      tx,
      provider: null,
    };
  }

  // ---------------------- ELECTRICITY ----------------------

  if (serviceType === "ELECTRICITY") {
    const { tx } =
      await createElectricityTx({
        userId,

        body: {
          ...meta,
          network: payload.network,
        },

        idempotencyKey,
      });

    const debited = await atomicDebit(
      userId,
      tx.amount
    );

    if (!debited) {
      tx.status = "FAILED";
      tx.processingStage = "FAILED";

      tx.statusMessage =
        "Insufficient wallet balance.";

      tx.lastError =
        "Insufficient balance";

      tx.completedAt = new Date();

      await tx.save();

      const err = new Error(
        "Insufficient balance"
      );

      err.status = 400;

      throw err;
    }

    await ledgerDebit({
      userId,
      tx,
      amount: tx.amount,
    });

    await recordTransactionEvent(tx, {
      status: "PROCESSING",
      processingStage: "CREATED",
      message: tx.statusMessage,
      source: "SYSTEM",
    });

    return {
      tx,
      provider: null,
    };
  }

  // ---------------------- CABLE / TV ----------------------

  if (
    serviceType === "TV" ||
    serviceType === "CABLE"
  ) {
    const { tx } =
      await createCableTx({
        userId,

        body: {
          ...meta,
          network: payload.network,
        },

        idempotencyKey,
      });

    const debited = await atomicDebit(
      userId,
      tx.amount
    );

    if (!debited) {
      tx.status = "FAILED";
      tx.processingStage = "FAILED";

      tx.statusMessage =
        "Insufficient wallet balance.";

      tx.lastError =
        "Insufficient balance";

      tx.completedAt = new Date();

      await tx.save();

      const err = new Error(
        "Insufficient balance"
      );

      err.status = 400;

      throw err;
    }

    await ledgerDebit({
      userId,
      tx,
      amount: tx.amount,
    });

    await recordTransactionEvent(tx, {
      status: "PROCESSING",
      processingStage: "CREATED",
      message: tx.statusMessage,
      source: "SYSTEM",
    });

    return {
      tx,
      provider: null,
    };
  }

  // ---------------------- AIRTIME TO CASH ----------------------

  if (
    serviceType === "AIRTIME_TO_CASH"
  ) {
    const { tx, sendTo } =
      await createA2CTx({
        userId,

        body: {
          ...meta,
          network: payload.network,
        },

        idempotencyKey,
      });

    return {
      tx,
      sendTo,
      provider: null,
    };
  }

  // ---------------------- EXAM PIN ----------------------

  if (
    serviceType === "EXAM_PIN" ||
    serviceType === "EXAM"
  ) {
    const { tx } =
      await createExamPinTx({
        userId,

        body: {
          ...meta,
        },

        idempotencyKey,
      });

    const debited = await atomicDebit(
      userId,
      tx.amount
    );

    if (!debited) {
      tx.status = "FAILED";
      tx.processingStage = "FAILED";

      tx.statusMessage =
        "Insufficient wallet balance.";

      tx.lastError =
        "Insufficient balance";

      tx.completedAt = new Date();

      await tx.save();

      const err = new Error(
        "Insufficient balance"
      );

      err.status = 400;

      throw err;
    }

    await ledgerDebit({
      userId,
      tx,
      amount: tx.amount,
    });

    await recordTransactionEvent(tx, {
      status: "PROCESSING",
      processingStage: "CREATED",
      message: tx.statusMessage,
      source: "SYSTEM",
    });

    return {
      tx,
      provider: null,
    };
  }

  // ---------------------- UNSUPPORTED ----------------------

  const err = new Error(
    `Unsupported serviceType: ${serviceType}`
  );

  err.status = 400;

  throw err;
}

module.exports = {
  createUnifiedTx,
  processDataTx,
};