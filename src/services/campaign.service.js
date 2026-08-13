const mongoose = require("mongoose");

const Campaign = require("../models/Campaign");
const CampaignReward = require("../models/CampaignReward");
const CampaignUserClaim = require("../models/CampaignUserClaim");
const Transaction = require("../models/Transaction");
const User = require("../models/User");
const WalletTx = require("../models/WalletTx");
const { notify } = require("./notification.service");

const QUALIFYING_TYPES = new Set([
  "DATA",
  "AIRTIME",
  "ELECTRICITY",
  "TV",
  "CABLE",
  "EXAM_PIN",
  "EXAM",
]);

function activeWindow(now = new Date()) {
  return {
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
    ],
  };
}

function audienceMatches(campaign, user) {
  const audience = String(campaign.audience || "ALL").toUpperCase();
  const role = String(user.role || "USER").toUpperCase();

  if (audience === "AGENT" && role !== "AGENT") return false;
  if (audience === "USER" && role !== "USER") return false;

  const tier = String(campaign.tier || "ANY").toUpperCase();
  if (tier !== "ANY" && tier !== String(user.tier || "USER").toUpperCase()) {
    return false;
  }

  return true;
}

function calculateReward(campaign, amount) {
  const base = Number(amount || 0);
  if (base <= 0) return 0;

  let reward =
    campaign.rewardType === "PERCENT"
      ? (base * Number(campaign.rewardValue || 0)) / 100
      : Number(campaign.rewardValue || 0);

  if (campaign.maxReward > 0) {
    reward = Math.min(reward, Number(campaign.maxReward));
  }

  // Keep wallet rewards to the nearest kobo.
  return Math.max(0, Math.round(reward * 100) / 100);
}

async function isFirstSuccessfulPurchase(tx, campaign) {
  if (campaign.type !== "FIRST_PURCHASE") return true;

  const previous = await Transaction.exists({
    userId: tx.userId,
    status: "SUCCESS",
    _id: { $ne: tx._id },
    type: { $in: campaign.serviceTypes || [] },
  });

  return !previous;
}

/**
 * Applies at most ONE campaign reward to a successful transaction.
 *
 * Wallet credit + reward ledger + campaign budget reservation are committed
 * together in a MongoDB transaction. This is intentionally fail-closed:
 * if MongoDB transactions are unavailable, no campaign money is credited.
 */
async function applyCampaignReward(tx) {
  if (!tx?.userId || tx.status !== "SUCCESS") return null;

  const serviceType = String(tx.type || "").toUpperCase();
  if (!QUALIFYING_TYPES.has(serviceType)) return null;

  const user = await User.findById(tx.userId).select("role tier fullName phone");
  if (!user) return null;

  const amount = Number(tx.sellPrice || tx.amount || 0);
  const now = new Date();

  const campaigns = await Campaign.find({
    isActive: true,
    serviceTypes: serviceType,
    minTransactionAmount: { $lte: amount },
    ...activeWindow(now),
  })
    .sort({ priority: -1, createdAt: -1 })
    .limit(10)
    .lean();

  for (const campaign of campaigns) {
    if (!audienceMatches(campaign, user)) continue;

    if (!(await isFirstSuccessfulPurchase(tx, campaign))) continue;

    const reward = calculateReward(campaign, amount);
    if (reward <= 0) continue;

    const perUserLimit = Math.max(0, Number(campaign.perUserLimit || 0));
    const claimKey = `CAMPAIGN:${campaign._id}:TX:${tx._id}`;

    const session = await mongoose.startSession();

    try {
      let rewardDoc;

      await session.withTransaction(async () => {
        // Reserve one per-user claim atomically when the campaign has a limit.
        // The reservation is part of the same transaction, so a failed
        // cashback rolls it back. A unique campaign+user record prevents
        // concurrent requests from bypassing the limit.
        if (perUserLimit > 0) {
          let reserved = await CampaignUserClaim.findOneAndUpdate(
            {
              campaignId: campaign._id,
              userId: tx.userId,
              claims: { $lt: perUserLimit },
            },
            { $inc: { claims: 1 } },
            { new: true, session }
          );

          if (!reserved) {
            try {
              reserved = await CampaignUserClaim.create(
                [{
                  campaignId: campaign._id,
                  userId: tx.userId,
                  claims: 1,
                }],
                { session }
              ).then((docs) => docs[0]);
            } catch (claimError) {
              if (claimError?.code === 11000) {
                throw new Error("Campaign per-user limit reached");
              }
              throw claimError;
            }
          }
        }

        // A unique claim key makes this idempotent.
        rewardDoc = await CampaignReward.create(
          [
            {
              campaignId: campaign._id,
              userId: user._id,
              transactionId: tx._id,
              amount: reward,
              status: "PAID",
              claimKey,
            },
          ],
          { session }
        );

        // Reserve campaign budget atomically. 0 means unlimited.
        const reserved = await Campaign.findOneAndUpdate(
          {
            _id: campaign._id,
            isActive: true,
            $or: [
              { budget: 0 },
              {
                $expr: {
                  $lte: [
                    { $add: ["$budgetUsed", reward] },
                    "$budget",
                  ],
                },
              },
            ],
          },
          {
            $inc: {
              budgetUsed: reward,
              totalClaims: 1,
            },
          },
          { new: true, session }
        );

        if (!reserved) {
          throw new Error("Campaign budget exhausted");
        }

        await User.updateOne(
          { _id: user._id },
          { $inc: { walletBalance: reward } },
          { session }
        );

        await WalletTx.create(
          [
            {
              userId: user._id,
              type: "CREDIT",
              amount: reward,
              reference: `CAMP_${campaign._id}_${tx._id}`,
              status: "SUCCESS",
              provider: "NEX",
              meta: {
                reward: "CAMPAIGN_CASHBACK",
                campaignId: String(campaign._id),
                campaignName: campaign.name,
                transactionId: String(tx._id),
                transactionReference: tx.reference,
              },
            },
          ],
          { session }
        );
      });

      await session.endSession();

      await notify({
        userId: user._id,
        type: "CAMPAIGN_REWARD",
        title: `${campaign.title} 🎁`,
        message: `You received ₦${reward.toLocaleString()} cashback from this transaction.`,
        txId: tx._id,
        dedupeKey: `CAMPAIGN_REWARD:${campaign._id}:${tx._id}`,
      }).catch((e) =>
        console.error("[campaign] notification error:", e.message)
      );

      return rewardDoc?.[0] || null;
    } catch (error) {
      await session.endSession().catch(() => {});

      // Another campaign may still be eligible. Duplicate claim means this
      // campaign has already rewarded this user/transaction.
      if (error?.code === 11000) continue;

      if (
        error?.message === "Campaign budget exhausted" ||
        error?.message === "Campaign per-user limit reached"
      ) {
        continue;
      }

      // Fail closed for financial safety.
      console.error(
        `[campaign] reward skipped for ${campaign.name}:`,
        error.message
      );
      continue;
    }
  }

  return null;
}

module.exports = {
  applyCampaignReward,
  calculateReward,
};
