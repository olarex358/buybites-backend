const mongoose = require("mongoose");
const User = require("../models/User");
const WalletTx = require("../models/WalletTx");
const ReferralReward = require("../models/ReferralReward");
const { notify } = require("./notification.service");

const REFERRER_BONUS = Math.max(0, Number(process.env.REFERRER_BONUS || 50));
const REFEREE_BONUS = Math.max(0, Number(process.env.REFEREE_BONUS || 50));
const MIN_QUALIFYING_AMOUNT = Math.max(0, Number(process.env.REFERRAL_MIN_TX || 100));

const QUALIFYING_TYPES = new Set([
  "DATA",
  "AIRTIME",
  "ELECTRICITY",
  "TV",
  "CABLE",
]);

async function creditReward(userId, amount, reference, meta, session) {
  if (!amount || amount <= 0) return false;

  const exists = await WalletTx.findOne({ reference }).select("_id").session(session);
  if (exists) return false;

  const user = await User.findOneAndUpdate(
    { _id: userId },
    { $inc: { walletBalance: amount } },
    { new: true, session }
  );

  if (!user) return false;

  try {
    await WalletTx.create(
      [{
        userId,
        type: "CREDIT",
        amount,
        reference,
        status: "SUCCESS",
        provider: "NEX",
        meta,
      }],
      { session }
    );
    return true;
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }
}

/**
 * Pays the referral reward exactly once when the referred user's first
 * qualifying service transaction succeeds.
 */
async function rewardFirstSuccessfulReferral(tx) {
  if (!tx?.userId || !QUALIFYING_TYPES.has(String(tx.type).toUpperCase())) {
    return null;
  }

  const amount = Number(tx.sellPrice || tx.amount || 0);
  if (amount < MIN_QUALIFYING_AMOUNT) return null;

  const session = await mongoose.startSession();

  try {
    let result = null;

    await session.withTransaction(async () => {
      // Claim the referral bonus and all wallet/ledger writes in the same
      // transaction. This prevents partial referral payouts.
      const referred = await User.findOneAndUpdate(
        {
          _id: tx.userId,
          referralBonusPaid: false,
          referredBy: { $exists: true, $nin: [null, ""] },
        },
        { $set: { referralBonusPaid: true } },
        { new: true, session }
      ).select("_id fullName phone referredBy");

      if (!referred?.referredBy) return;

      const referrer = await User.findOne({
        referralCode: String(referred.referredBy).toUpperCase(),
      }).select("_id fullName phone").session(session);

      if (!referrer) {
        throw new Error("REFERRER_NOT_FOUND");
      }

      const reward = await ReferralReward.findOneAndUpdate(
        { transactionId: tx._id },
        {
          $setOnInsert: {
            referrerId: referrer._id,
            referredUserId: referred._id,
            transactionId: tx._id,
            referrerAmount: REFERRER_BONUS,
            refereeAmount: REFEREE_BONUS,
            status: "PAID",
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true, session }
      );

      // If the reward already existed, do not issue another wallet credit.
      // This makes retries safe.
      const rewardWasAlreadyPaid = reward?.createdAt &&
        reward.createdAt.getTime() < Date.now() - 1000;

      if (rewardWasAlreadyPaid) {
        result = reward;
        return;
      }

      const referrerCredited = await creditReward(
        referrer._id,
        REFERRER_BONUS,
        `REFR:${tx.reference}`,
        {
          reward: "REFERRER_BONUS",
          transactionId: String(tx._id),
          referredUserId: String(referred._id),
        },
        session
      );

      const refereeCredited = await creditReward(
        referred._id,
        REFEREE_BONUS,
        `REFD:${tx.reference}`,
        {
          reward: "REFEREE_BONUS",
          transactionId: String(tx._id),
          referrerId: String(referrer._id),
        },
        session
      );

      // If either side could not be credited, abort the whole transaction.
      // No partial reward is allowed.
      if ((REFERRER_BONUS > 0 && !referrerCredited) ||
          (REFEREE_BONUS > 0 && !refereeCredited)) {
        throw new Error("REFERRAL_REWARD_CREDIT_FAILED");
      }

      result = reward;
    });

    // Notifications are deliberately outside the DB transaction because
    // they are external side effects and must not affect wallet atomicity.
    if (result) {
      if (REFERRER_BONUS > 0) {
        const referred = await User.findById(tx.userId).select("fullName phone");
        const referrer = await User.findById(result.referrerId).select("_id");
        if (referrer) {
          await notify({
            userId: referrer._id,
            type: "REFERRAL_REWARD",
            title: "Referral reward earned 🎉",
            message: `You earned ₦${REFERRER_BONUS.toLocaleString()} because ${referred?.fullName || referred?.phone || "your referral"} completed their first purchase.`,
            dedupeKey: `REFERRAL_REWARD:REFERRER:${tx._id}`,
          });
        }
      }

      if (REFEREE_BONUS > 0) {
        await notify({
          userId: tx.userId,
          type: "REFERRAL_REWARD",
          title: "Welcome bonus unlocked 🎁",
          message: `Your first purchase unlocked a ₦${REFEREE_BONUS.toLocaleString()} referral bonus.`,
          txId: tx._id,
          dedupeKey: `REFERRAL_REWARD:REFEREE:${tx._id}`,
        });
      }
    }

    return result;
  } catch (error) {
    if (error?.message === "REFERRER_NOT_FOUND") {
      return null;
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

module.exports = {
  rewardFirstSuccessfulReferral,
  REFERRER_BONUS,
  REFEREE_BONUS,
  MIN_QUALIFYING_AMOUNT,
};
