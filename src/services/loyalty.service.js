const mongoose = require("mongoose");

const User = require("../models/User");
const LoyaltyLedger = require("../models/LoyaltyLedger");
const { notify } = require("./notification.service");
const { getStreakSnapshot } = require("./streak.service");

const NAIRA_PER_POINT = Math.max(
  1,
  Number(process.env.LOYALTY_NAIRA_PER_POINT || 100)
);

const LEVELS = [
  { key: "STARTER", label: "Starter", min: 0, icon: "🌱" },
  { key: "RISING", label: "Rising", min: 100, icon: "🚀" },
  { key: "PLUS", label: "Plus", min: 300, icon: "⭐" },
  { key: "PRO", label: "Pro", min: 750, icon: "🔥" },
  { key: "VIP", label: "VIP", min: 1500, icon: "💎" },
  { key: "ELITE", label: "Elite", min: 3000, icon: "👑" },
];

const AGENT_RANKS = [
  { key: "BRONZE", label: "Bronze", minVolume: 0, icon: "🥉" },
  { key: "SILVER", label: "Silver", minVolume: 50_000, icon: "🥈" },
  { key: "GOLD", label: "Gold", minVolume: 250_000, icon: "🥇" },
  { key: "PLATINUM", label: "Platinum", minVolume: 1_000_000, icon: "💠" },
  { key: "ELITE", label: "Elite", minVolume: 5_000_000, icon: "👑" },
];

const QUALIFYING_TYPES = new Set([
  "DATA",
  "AIRTIME",
  "ELECTRICITY",
  "TV",
  "CABLE",
  "EXAM_PIN",
  "EXAM",
]);

function levelForPoints(points) {
  const value = Math.max(0, Number(points || 0));
  let current = LEVELS[0];

  for (const level of LEVELS) {
    if (value >= level.min) current = level;
  }

  return current;
}

function nextLevel(points) {
  const current = levelForPoints(points);
  const index = LEVELS.findIndex((level) => level.key === current.key);
  return LEVELS[index + 1] || null;
}

function rankForVolume(volume) {
  const value = Math.max(0, Number(volume || 0));
  let current = AGENT_RANKS[0];

  for (const rank of AGENT_RANKS) {
    if (value >= rank.minVolume) current = rank;
  }

  return current;
}

function nextRank(volume) {
  const current = rankForVolume(volume);
  const index = AGENT_RANKS.findIndex((rank) => rank.key === current.key);
  return AGENT_RANKS[index + 1] || null;
}

function calculatePoints(amount) {
  const value = Math.max(0, Number(amount || 0));
  if (!value) return 0;
  return Math.max(1, Math.floor(value / NAIRA_PER_POINT));
}

async function awardLoyaltyPoints(tx) {
  if (!tx?.userId || tx.status !== "SUCCESS") return null;

  const type = String(tx.type || "").toUpperCase();
  if (!QUALIFYING_TYPES.has(type)) return null;

  const points = calculatePoints(tx.sellPrice || tx.amount);
  if (points <= 0) return null;

  const session = await mongoose.startSession();

  try {
    let result = null;

    await session.withTransaction(async () => {
      const reference = `POINTS:${tx.reference}`;

      // Unique transactionId/reference makes this reward idempotent.
      const created = await LoyaltyLedger.create(
        [
          {
            userId: tx.userId,
            transactionId: tx._id,
            points,
            reason: `Points for ${type} purchase`,
            reference,
          },
        ],
        { session }
      );

      const before = await User.findById(tx.userId)
        .select("lifetimePoints loyaltyLevel role totalVolume agentRank")
        .session(session);

      if (!before) throw new Error("User not found");

      const oldLevel = before.loyaltyLevel || levelForPoints(before.lifetimePoints).key;
      const newLifetime = Number(before.lifetimePoints || 0) + points;
      const newLevel = levelForPoints(newLifetime);

      const newVolume = Number(before.totalVolume || 0);
      const newRank = rankForVolume(newVolume);

      await User.updateOne(
        { _id: tx.userId },
        {
          $inc: {
            loyaltyPoints: points,
            lifetimePoints: points,
          },
          $set: {
            loyaltyLevel: newLevel.key,
            agentRank: newRank.key,
          },
        },
        { session }
      );

      result = {
        points,
        lifetimePoints: newLifetime,
        oldLevel,
        newLevel: newLevel.key,
        tierUp: oldLevel !== newLevel.key,
        ledgerId: created?.[0]?._id,
      };
    });

    await session.endSession();

    if (result?.tierUp) {
      const level = levelForPoints(result.lifetimePoints);

      await notify({
        userId: tx.userId,
        type: "LOYALTY_LEVEL_UP",
        title: `${level.icon} NEX ${level.label} unlocked!`,
        message: `You've reached ${level.label} level. Keep using NEX to unlock the next level.`,
        txId: tx._id,
        dedupeKey: `LOYALTY_LEVEL:${tx.userId}:${result.newLevel}`,
      }).catch((e) =>
        console.error("[loyalty] level notification:", e.message)
      );
    }

    return result;
  } catch (error) {
    await session.endSession().catch(() => {});

    // Duplicate claim is harmless: points were already awarded.
    if (error?.code === 11000) return null;

    console.error("[loyalty] points award skipped:", error.message);
    return null;
  }
}

function progress(current, next, currentValue) {
  if (!next) return 100;

  const start = Number(current?.min || current?.minVolume || 0);
  const end = Number(next?.min || next?.minVolume || 0);
  const value = Number(currentValue || 0);

  if (end <= start) return 100;
  return Math.min(100, Math.max(0, Number((((value - start) / (end - start)) * 100).toFixed(1))));
}

async function getLoyaltySnapshot(userId) {
  const user = await User.findById(userId)
    .select("role tier loyaltyPoints lifetimePoints loyaltyLevel agentRank totalVolume totalProfit")
    .lean();

  if (!user) return null;

  const points = Number(user.loyaltyPoints || 0);
  const lifetimePoints = Number(user.lifetimePoints || 0);
  const level = levelForPoints(lifetimePoints);
  const next = nextLevel(lifetimePoints);
  const streak = await getStreakSnapshot(userId);

  const snapshot = {
    points,
    lifetimePoints,
    level: {
      key: level.key,
      label: level.label,
      icon: level.icon,
      min: level.min,
    },
    nextLevel: next
      ? {
          key: next.key,
          label: next.label,
          icon: next.icon,
          min: next.min,
          pointsNeeded: Math.max(0, next.min - lifetimePoints),
          progress: progress(level, next, lifetimePoints),
        }
      : null,
    pointsRate: `1 point per ₦${NAIRA_PER_POINT.toLocaleString()} spent`,
    streak: streak || {
      currentStreak: 0,
      storedStreak: 0,
      longestStreak: 0,
      lastActivityDate: null,
      active: false,
      todayCompleted: false,
      nextMilestone: 3,
    },
  };

  if (String(user.role || "").toUpperCase() === "AGENT") {
    const volume = Number(user.totalVolume || 0);
    const rank = rankForVolume(volume);
    const nextAgent = nextRank(volume);

    snapshot.agent = {
      rank: {
        key: rank.key,
        label: rank.label,
        icon: rank.icon,
        minVolume: rank.minVolume,
      },
      volume,
      nextRank: nextAgent
        ? {
            key: nextAgent.key,
            label: nextAgent.label,
            icon: nextAgent.icon,
            volumeNeeded: Math.max(0, nextAgent.minVolume - volume),
            progress: progress(rank, nextAgent, volume),
          }
        : null,
    };
  }

  return snapshot;
}

async function getLoyaltyHistory(userId, limit = 20) {
  return LoyaltyLedger.find({ userId })
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 20, 1), 100))
    .lean();
}

module.exports = {
  awardLoyaltyPoints,
  getLoyaltySnapshot,
  getLoyaltyHistory,
  calculatePoints,
  levelForPoints,
  rankForVolume,
  LEVELS,
  AGENT_RANKS,
  NAIRA_PER_POINT,
};
