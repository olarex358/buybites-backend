const crypto = require("crypto");
const Transaction = require("../models/Transaction");
const {
  finalizeSuccess,
  finalizeRefund,
  markProviderUnknown,
  setProcessingStage,
} = require("./tx.lifecycle");
const { processDataTx } = require("./tx.engine");
const { processAirtimeTx } = require("./tx.airtime");
const { processElectricityTx } = require("./tx.electricity");
const { processCableTx } = require("./tx.cable");
const { recordProviderAttempt } = require("./provider.health");

const LOCK_TTL_MS = 90 * 1000;
const WORKER_INTERVAL_MS = 5000;
const BATCH_SIZE = 10;

function isNetworkOrTimeoutError(error) {
  if (!error) return false;

  const code = String(error.code || "").toUpperCase();
  if (["ECONNABORTED", "ETIMEDOUT", "ERR_NETWORK", "ENETUNREACH", "ECONNRESET", "EAI_AGAIN", "ECONNREFUSED"].includes(code)) {
    return true;
  }

  // Axios network failures normally have a request object but no response.
  // Do not classify arbitrary application/configuration errors this way.
  return !!error.request && !error.response;
}

function providerReference(provider) {
  return provider?.reference || provider?.ref || provider?.data?.reference || provider?.data?.ref || "";
}

async function claimTransaction(txId) {
  const now = new Date();
  const stale = new Date(Date.now() - LOCK_TTL_MS);
  const lockId = crypto.randomBytes(12).toString("hex");

  const tx = await Transaction.findOneAndUpdate(
    {
      _id: txId,
      status: "PROCESSING",
      $or: [
        { processingLockId: { $exists: false } },
        { processingLockId: "" },
        { processingLockedAt: { $lt: stale } },
      ],
    },
    {
      $set: {
        processingLockId: lockId,
        processingLockedAt: now,
      },
    },
    { new: true }
  );

  return tx ? { tx, lockId } : null;
}

async function releaseLock(tx, lockId) {
  if (!tx || !lockId) return;
  await Transaction.updateOne(
    { _id: tx._id, processingLockId: lockId },
    { $set: { processingLockId: "" }, $unset: { processingLockedAt: 1 } }
  );
}

async function processTransactionById(txId) {
  const claimed = await claimTransaction(txId);
  if (!claimed) return null;

  const { tx, lockId } = claimed;

  try {
    await setProcessingStage(tx, "PROVIDER_REQUESTED", "Sending your transaction to the service provider…");

    let result;
    if (tx.type === "DATA") {
      result = await processDataTx(tx);
    } else if (tx.type === "AIRTIME") {
      result = await processAirtimeTx(tx);
    } else if (tx.type === "ELECTRICITY") {
      result = await processElectricityTx(tx);
    } else if (tx.type === "TV" || tx.type === "CABLE") {
      result = await processCableTx(tx);
    } else {
      // Manual services such as EXAM_PIN/AIRTIME_TO_CASH stay in PROCESSING.
      tx.processingStage = "MANUAL_REVIEW";
      tx.statusMessage = "Your request has been received and is awaiting processing.";
      await tx.save();
      return tx;
    }

    const providerRef = providerReference(result?.provider);

    const providerName = String(
      tx.provider || result?.providerMeta?.provider || ""
    ).toUpperCase();

    if (result?.providerMeta) {
      tx.meta = {
        ...(tx.meta || {}),
        provider: providerName,
        providerLatencyMs: result.providerMeta.latencyMs,
        providerOperation: result.providerMeta.operation,
      };
      await tx.save();
    }

    if (result?.ok) {
      await recordProviderAttempt({
        provider: providerName,
        service: tx.type,
        outcome: "SUCCESS",
        latencyMs: result?.providerMeta?.latencyMs,
      }).catch((e) => console.error("[provider.health] success record:", e.message));
      await finalizeSuccess(tx, { providerRef, token: result?.token || "" });
      return tx;
    }

    await recordProviderAttempt({
      provider: providerName,
      service: tx.type,
      outcome: "FAILURE",
      latencyMs: result?.providerMeta?.latencyMs,
    }).catch((e) => console.error("[provider.health] failure record:", e.message));

    await finalizeRefund(
      tx,
      result?.provider?.message || result?.provider?.error || "The service provider could not complete the transaction."
    );
    return tx;
  } catch (error) {
    const message = error?.response?.data
      ? JSON.stringify(error.response.data)
      : error?.message || "Provider request failed";

    console.error(`[tx.processor] ${tx.reference}:`, message);

    if (isNetworkOrTimeoutError(error)) {
      await recordProviderAttempt({
        provider: String(tx.provider || "").toUpperCase(),
        service: tx.type,
        outcome: "UNKNOWN",
        latencyMs: error?.providerMeta?.latencyMs,
      }).catch((e) => console.error("[provider.health] unknown record:", e.message));

      await markProviderUnknown(tx, message);
      return tx;
    }

    // An HTTP/provider response means the provider rejected the request rather than
    // disappearing. Refund safely because the transaction has not been confirmed.
    await finalizeRefund(tx, message);
    return tx;
  } finally {
    await releaseLock(tx, lockId).catch(() => {});
  }
}

function scheduleTransactionProcessing(txId) {
  setImmediate(() => {
    processTransactionById(txId).catch((error) => {
      console.error("[tx.processor] background processing error:", error.message);
    });
  });
}

async function recoverProcessingTransactions() {
  const stale = new Date(Date.now() - LOCK_TTL_MS);
  const txs = await Transaction.find({
    status: "PROCESSING",
    processingStage: "CREATED",
    $or: [
      { processingLockId: { $exists: false } },
      { processingLockId: "" },
      { processingLockedAt: { $lt: stale } },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(BATCH_SIZE)
    .select("_id processingStage nextCheckAt");

  for (const tx of txs) {
    // Only newly-created transactions are automatically claimed. A transaction
    // that already reached PROVIDER_REQUESTED is never replayed blindly because
    // the provider may have completed it before the process crashed.
    scheduleTransactionProcessing(tx._id);
  }
}

function startTransactionWorker() {
  const run = async () => {
    try {
      await recoverProcessingTransactions();
    } catch (error) {
      console.error("[tx.processor] worker error:", error.message);
    }
  };

  run();
  return setInterval(run, WORKER_INTERVAL_MS);
}

module.exports = {
  processTransactionById,
  scheduleTransactionProcessing,
  startTransactionWorker,
};
