const crypto = require("crypto");
const Transaction = require("../models/Transaction");
const {
  finalizeSuccess,
  finalizeRefund,
  markProviderUnknown,
} = require("./tx.lifecycle");
const { requeryTransaction } = require("./provider.requery");
const { notify } = require("./notification.service");
const { recordProviderAttempt } = require("./provider.health");
const { recordTransactionEvent } = require("./tx.events");

const INTERVAL_MS = 15000;
const BATCH_SIZE = 20;
const MAX_REQUERY_ATTEMPTS = 5;
const LOCK_TTL_MS = 60 * 1000;

function nextDelay(attempt) {
  // 30s → 1m → 2m → 4m → 8m, capped at 10m.
  return Math.min(10 * 60 * 1000, 30 * 1000 * (2 ** Math.max(0, attempt - 1)));
}

async function markManualReview(tx, reason) {
  tx.processingStage = "MANUAL_REVIEW";
  tx.manualReviewAt = new Date();
  tx.nextCheckAt = null;
  tx.statusMessage =
    "Your transaction is taking longer than expected. NEX has flagged it for review.";
  tx.lastError = reason || tx.lastError || "Provider status could not be confirmed.";
  await tx.save();

  await recordTransactionEvent(tx, {
    status: "PROCESSING",
    processingStage: "MANUAL_REVIEW",
    message: tx.statusMessage,
    source: "REQUERY",
    providerRef: tx.providerRef,
  });

  await notify({
    userId: tx.userId,
    type: "TRANSACTION_REVIEW",
    title: "Transaction needs review",
    message:
      "Your transaction is taking longer than expected. Please don't purchase again. NEX has flagged it for review.",
    txId: tx._id,
    dedupeKey: `TX_REVIEW:${tx._id}`,
  });
}

async function claim(txId) {
  const now = new Date();
  const stale = new Date(Date.now() - LOCK_TTL_MS);
  const lockId = crypto.randomBytes(10).toString("hex");

  const tx = await Transaction.findOneAndUpdate(
    {
      _id: txId,
      status: "PROCESSING",
      processingStage: "PROVIDER_UNKNOWN",
      nextCheckAt: { $lte: now },
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
        lastRequeryAt: now,
      },
      $inc: { requeryAttempts: 1 },
    },
    { new: true }
  );

  return tx ? { tx, lockId } : null;
}

async function release(tx, lockId) {
  await Transaction.updateOne(
    { _id: tx._id, processingLockId: lockId },
    { $set: { processingLockId: "" }, $unset: { processingLockedAt: 1 } }
  );
}

async function reconcileOne(txId) {
  const claimed = await claim(txId);
  if (!claimed) return null;

  const { tx, lockId } = claimed;

  try {
    if (tx.requeryAttempts > MAX_REQUERY_ATTEMPTS) {
      await markManualReview(tx, "Maximum automatic status checks reached.");
      return tx;
    }

    const result = await requeryTransaction(tx);

    if (!result.supported) {
      // No undocumented endpoint is guessed. Keep the transaction visible as
      // processing and eventually route it to manual review.
      tx.nextCheckAt = new Date(Date.now() + nextDelay(tx.requeryAttempts));
      tx.statusMessage =
        "Your transaction is still being processed. NEX is waiting for the provider's confirmation.";
      await tx.save();

      if (tx.requeryAttempts >= MAX_REQUERY_ATTEMPTS) {
        await markManualReview(tx, result.message);
      }
      return tx;
    }

    if (result.providerMeta) {
      tx.meta = {
        ...(tx.meta || {}),
        requeryLatencyMs: result.providerMeta.latencyMs,
        lastRequeryOperation: result.providerMeta.operation,
      };
    }

    if (result.providerRef) tx.providerRef = result.providerRef;

    if (result.status === "SUCCESS") {
      await recordProviderAttempt({
        provider: tx.provider,
        service: tx.type,
        outcome: "SUCCESS",
        latencyMs: result.providerMeta?.latencyMs,
      }).catch((e) => console.error("[provider.health] requery success:", e.message));

      await finalizeSuccess(tx, {
        providerRef: result.providerRef,
        token: result.token,
        eventSource: "REQUERY",
      });
      return tx;
    }

    if (result.status === "FAILED") {
      await recordProviderAttempt({
        provider: tx.provider,
        service: tx.type,
        outcome: "FAILURE",
        latencyMs: result.providerMeta?.latencyMs,
      }).catch((e) => console.error("[provider.health] requery failure:", e.message));

      await finalizeRefund(tx, result.message || "Provider confirmed the transaction failed.");
      return tx;
    }

    await recordProviderAttempt({
      provider: tx.provider,
      service: tx.type,
      outcome: "UNKNOWN",
      latencyMs: result.providerMeta?.latencyMs,
    }).catch((e) => console.error("[provider.health] requery unknown:", e.message));

    tx.processingStage = "PROVIDER_UNKNOWN";
    tx.statusMessage =
      "Your transaction is still being processed. Please don't purchase again.";
    tx.nextCheckAt = new Date(Date.now() + nextDelay(tx.requeryAttempts));
    await tx.save();

    await recordTransactionEvent(tx, {
      status: "PROCESSING",
      processingStage: "PROVIDER_UNKNOWN",
      message: tx.statusMessage,
      source: "REQUERY",
      providerRef: tx.providerRef,
      meta: { requeryAttempts: tx.requeryAttempts },
    });

    return tx;
  } catch (error) {
    tx.lastError = error?.message || "Status requery failed";
    tx.nextCheckAt = new Date(Date.now() + nextDelay(tx.requeryAttempts));
    await tx.save();
    return tx;
  } finally {
    await release(tx, lockId).catch(() => {});
  }
}

async function recoverUnknownTransactions() {
  const now = new Date();
  const txs = await Transaction.find({
    status: "PROCESSING",
    processingStage: "PROVIDER_UNKNOWN",
    nextCheckAt: { $lte: now },
    $or: [
      { processingLockId: { $exists: false } },
      { processingLockId: "" },
      { processingLockedAt: { $lt: new Date(Date.now() - LOCK_TTL_MS) } },
    ],
  })
    .sort({ nextCheckAt: 1 })
    .limit(BATCH_SIZE)
    .select("_id");

  for (const tx of txs) {
    reconcileOne(tx._id).catch((e) =>
      console.error("[tx.reconciliation]", e.message)
    );
  }
}

function startReconciliationWorker() {
  const run = async () => {
    try {
      await recoverUnknownTransactions();
    } catch (e) {
      console.error("[tx.reconciliation] worker error:", e.message);
    }
  };

  run();
  return setInterval(run, INTERVAL_MS);
}

module.exports = {
  reconcileOne,
  startReconciliationWorker,
};
