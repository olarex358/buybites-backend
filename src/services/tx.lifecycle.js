const mongoose = require("mongoose");
const User = require("../models/User");
const WalletTx = require("../models/WalletTx");
const Transaction = require("../models/Transaction");
const { notifyTransactionStatus } = require("./notification.service");
const { rewardFirstSuccessfulReferral } = require("./referral.service");
const { applyCampaignReward } = require("./campaign.service");
const { awardLoyaltyPoints } = require("./loyalty.service");
const { recordStreakActivity } = require("./streak.service");
const { recordTransactionEvent } = require("./tx.events");

async function atomicDebit(userId, amount) {
  return User.findOneAndUpdate(
    { _id: userId, walletBalance: { $gte: amount } },
    { $inc: { walletBalance: -amount } },
    { new: true }
  );
}

async function atomicCredit(userId, amount) {
  return User.findByIdAndUpdate(userId, { $inc: { walletBalance: amount } });
}

async function ledgerDebit({ userId, tx, amount }) {
  const debitRef = `DEB_${tx.reference}`;
  const exists = await WalletTx.findOne({ reference: debitRef }).select("_id");
  if (exists) return false;

  await WalletTx.create({
    userId,
    type: "DEBIT",
    amount,
    reference: debitRef,
    status: "SUCCESS",
    meta: {
      txId: String(tx._id),
      reference: tx.reference,
      type: tx.type,
      ...tx.meta,
    },
  });
  return true;
}

async function refundIfNeeded({ userId, tx, amount, reason }) {
  const refundRef = `CR_${tx.reference}`;
  const normalizedAmount = Number(amount || 0);
  if (!userId || !refundRef || normalizedAmount <= 0) return false;

  // Wallet credit + refund ledger are committed together. The unique refund
  // reference makes the operation idempotent even if two workers race.
  const session = await mongoose.startSession();
  try {
    let credited = false;

    await session.withTransaction(async () => {
      const existing = await WalletTx.findOne({ reference: refundRef })
        .select("_id status")
        .session(session);

      if (existing) return;

      await WalletTx.create(
        [
          {
            userId,
            type: "CREDIT",
            amount: normalizedAmount,
            reference: refundRef,
            status: "SUCCESS",
            meta: {
              txId: String(tx._id),
              reference: tx.reference,
              reason,
              operation: "TRANSACTION_REFUND",
            },
          },
        ],
        { session }
      );

      const updated = await User.updateOne(
        { _id: userId },
        { $inc: { walletBalance: normalizedAmount } },
        { session }
      );

      if (updated.matchedCount !== 1) {
        throw new Error("User not found while applying refund");
      }

      credited = true;
    });

    return credited;
  } catch (error) {
    // Another worker may have created the unique refund ledger first. In that
    // case the other transaction owns the credit and this call must be a no-op.
    if (error?.code === 11000) {
      const existing = await WalletTx.findOne({ reference: refundRef }).select("_id status");
      return !existing;
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

async function setProcessingStage(tx, stage, message = "") {
  tx.processingStage = stage;
  if (message) tx.statusMessage = message;
  tx.lastProviderAttemptAt = new Date();
  await tx.save();

  await recordTransactionEvent(tx, {
    status: tx.status,
    processingStage: stage,
    message: tx.statusMessage,
    source: "PROVIDER",
    providerRef: tx.providerRef,
  });
}

async function finalizeSuccess(
  tx,
  { providerRef = "", token = "", eventSource = "PROVIDER" } = {}
) {
  if (tx.status !== "PROCESSING") return false;

  tx.status = "SUCCESS";
  tx.processingStage = "COMPLETED";
  tx.statusMessage = "Transaction completed successfully.";
  tx.completedAt = new Date();
  tx.nextCheckAt = null;
  if (providerRef) tx.providerRef = String(providerRef);
  if (token) tx.meta = { ...(tx.meta || {}), token };
  await tx.save();

  await recordTransactionEvent(tx, {
    status: "SUCCESS",
    processingStage: "COMPLETED",
    message: tx.statusMessage,
    source: eventSource,
    providerRef: tx.providerRef,
  });

  await User.findByIdAndUpdate(tx.userId, {
    $inc: {
      totalVolume: Number(tx.sellPrice || tx.amount || 0),
      totalProfit: Number(tx.profit || 0),
    },
  });

  await notifyTransactionStatus(tx, "SUCCESS");

  // Referral reward is deliberately best-effort and idempotent. A failure here
  // must never turn a successful customer purchase into a failed transaction.
  await rewardFirstSuccessfulReferral(tx).catch((error) => {
    console.error("[referral] reward error:", error.message);
  });

  // Campaign cashback is also best-effort. The purchase remains successful
  // even if a promotion cannot be applied.
  await applyCampaignReward(tx).catch((error) => {
    console.error("[campaign] reward error:", error.message);
  });

  // Loyalty points never block a successful service transaction.
  await awardLoyaltyPoints(tx).catch((error) => {
    console.error("[loyalty] points error:", error.message);
  });

  // Streaks are engagement metadata only. They never affect the wallet or
  // transaction outcome.
  await recordStreakActivity(tx).catch((error) => {
    console.error("[streak] activity error:", error.message);
  });

  return true;
}

async function finalizeRefund(tx, reason = "Provider failed") {
  if (tx.status !== "PROCESSING") return false;

  tx.lastError = String(reason || "Provider failed");
  tx.status = "REFUNDED";
  tx.processingStage = "REFUNDED";
  tx.statusMessage = "Transaction failed and your wallet has been refunded.";
  tx.completedAt = new Date();
  tx.nextCheckAt = null;
  await tx.save();

  await recordTransactionEvent(tx, {
    status: "REFUNDED",
    processingStage: "REFUNDED",
    message: tx.statusMessage,
    source: "PROVIDER",
    providerRef: tx.providerRef,
  });

  await refundIfNeeded({
    userId: tx.userId,
    tx,
    amount: tx.amount,
    reason: tx.lastError,
  });

  await notifyTransactionStatus(tx, "REFUNDED");
  return true;
}

async function markProviderUnknown(tx, errorMessage = "Provider response delayed") {
  if (tx.status !== "PROCESSING") return false;

  tx.processingStage = "PROVIDER_UNKNOWN";
  tx.statusMessage = "Your transaction is still being processed. Please don't purchase again.";
  tx.lastError = String(errorMessage || "Provider response delayed");
  tx.nextCheckAt = new Date(Date.now() + 60 * 1000);
  await tx.save();

  await recordTransactionEvent(tx, {
    status: "PROCESSING",
    processingStage: "PROVIDER_UNKNOWN",
    message: tx.statusMessage,
    source: "PROVIDER",
    providerRef: tx.providerRef,
  });

  await notifyTransactionStatus(tx, "PROCESSING");
  return true;
}

module.exports = {
  atomicDebit,
  atomicCredit,
  ledgerDebit,
  refundIfNeeded,
  setProcessingStage,
  finalizeSuccess,
  finalizeRefund,
  markProviderUnknown,
};
