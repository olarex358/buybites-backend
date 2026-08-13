const StreakLedger = require("../models/StreakLedger");
const { notify } = require("./notification.service");

const TIME_ZONE = process.env.NEX_STREAK_TZ || "Africa/Lagos";
const MILESTONES = [3, 7, 14, 30, 60, 100];

const QUALIFYING_TYPES = new Set([
  "DATA",
  "AIRTIME",
  "ELECTRICITY",
  "TV",
  "CABLE",
  "EXAM_PIN",
  "EXAM",
]);

function dateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDays(key, amount) {
  const [y, m, d] = String(key).split("-").map(Number);
  const value = new Date(Date.UTC(y, m - 1, d));
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function nextMilestone(current) {
  return MILESTONES.find((value) => value > Number(current || 0)) || null;
}

async function recordStreakActivity(tx) {
  if (!tx?.userId || tx.status !== "SUCCESS") return null;

  const type = String(tx.type || "").toUpperCase();
  if (!QUALIFYING_TYPES.has(type)) return null;

  const today = dateKey();

  // One activity per user/day. This keeps streaks engagement-focused rather
  // than rewarding repeated purchases on the same day.
  const existing = await StreakLedger.findOne({
    userId: tx.userId,
    activityDate: today,
  }).lean();

  if (existing) return existing;

  const yesterday = addDays(today, -1);
  const previous = await StreakLedger.findOne({
    userId: tx.userId,
    activityDate: yesterday,
  })
    .sort({ createdAt: -1 })
    .lean();

  const currentStreak = previous ? Number(previous.currentStreak || 0) + 1 : 1;
  const previousLongest = previous ? Number(previous.longestStreak || 0) : 0;
  const longestStreak = Math.max(previousLongest, currentStreak);

  let created;
  try {
    created = await StreakLedger.create({
      userId: tx.userId,
      activityDate: today,
      transactionId: tx._id,
      transactionReference: tx.reference,
      serviceType: type,
      currentStreak,
      longestStreak,
    });
  } catch (error) {
    if (error?.code === 11000) {
      return StreakLedger.findOne({
        userId: tx.userId,
        activityDate: today,
      }).lean();
    }
    throw error;
  }

  const reached = MILESTONES.includes(currentStreak);
  if (reached) {
    await StreakLedger.updateOne(
      { _id: created._id },
      { $set: { milestoneNotified: true } }
    );

    await notify({
      userId: tx.userId,
      type: "STREAK_MILESTONE",
      title: `🔥 ${currentStreak}-day NEX streak!`,
      message:
        currentStreak >= 100
          ? "Amazing consistency! You've reached a 100-day NEX streak."
          : `You've used NEX on ${currentStreak} consecutive days. Keep the streak going!`,
      txId: tx._id,
      priority: "IMPORTANT",
      actionUrl: "/loyalty",
      dedupeKey: `STREAK:${tx.userId}:${today}:${currentStreak}`,
    }).catch((error) => {
      console.error("[streak] milestone notification:", error.message);
    });
  }

  return created;
}

async function getStreakSnapshot(userId) {
  const today = dateKey();
  const yesterday = addDays(today, -1);

  const [todayRow, latest] = await Promise.all([
    StreakLedger.findOne({ userId, activityDate: today }).lean(),
    StreakLedger.findOne({
      userId,
      activityDate: { $in: [today, yesterday] },
    })
      .sort({ activityDate: -1 })
      .lean(),
  ]);

  if (!latest) {
    return {
      currentStreak: 0,
      storedStreak: 0,
      longestStreak: 0,
      lastActivityDate: null,
      active: false,
      todayCompleted: false,
      nextMilestone: 3,
    };
  }

  const active =
    latest.activityDate === today || latest.activityDate === yesterday;

  const currentStreak = active ? Number(latest.currentStreak || 0) : 0;

  return {
    currentStreak,
    storedStreak: Number(latest.currentStreak || 0),
    longestStreak: Number(latest.longestStreak || 0),
    lastActivityDate: latest.activityDate,
    active,
    todayCompleted: Boolean(todayRow),
    nextMilestone: nextMilestone(currentStreak),
  };
}

module.exports = {
  recordStreakActivity,
  getStreakSnapshot,
  dateKey,
  MILESTONES,
};
