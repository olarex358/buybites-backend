const PushSubscription = require("../models/PushSubscription");

let webpush = null;
try {
  // Optional at runtime until the dependency is installed on the deployment.
  webpush = require("web-push");
} catch {
  webpush = null;
}

function configured() {
  return Boolean(
    webpush &&
    process.env.VAPID_PUBLIC_KEY &&
    process.env.VAPID_PRIVATE_KEY &&
    process.env.VAPID_SUBJECT
  );
}

function configure() {
  if (!configured()) return false;

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  return true;
}

function publicKey() {
  return configured() ? process.env.VAPID_PUBLIC_KEY : null;
}

async function saveSubscription({ userId, subscription, userAgent = "" }) {
  const endpoint = String(subscription?.endpoint || "").trim();
  if (!userId || !endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    const error = new Error("Invalid push subscription");
    error.status = 400;
    throw error;
  }

  return PushSubscription.findOneAndUpdate(
    { endpoint },
    {
      userId,
      endpoint,
      subscription,
      userAgent: String(userAgent || "").slice(0, 500),
      lastUsedAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function removeSubscription({ userId, endpoint }) {
  const filter = { endpoint: String(endpoint || "").trim() };
  if (userId) filter.userId = userId;
  if (!filter.endpoint) return false;

  const result = await PushSubscription.deleteOne(filter);
  return result.deletedCount > 0;
}

async function sendToUser({ userId, title, message, data = {} }) {
  if (!configured()) return { configured: false, sent: 0, removed: 0 };

  configure();

  const rows = await PushSubscription.find({ userId }).lean();
  if (!rows.length) return { configured: true, sent: 0, removed: 0 };

  const payload = JSON.stringify({
    title: title || "NEX",
    body: message || "You have a new NEX update.",
    data,
  });

  let sent = 0;
  let removed = 0;

  await Promise.all(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(row.subscription, payload);
        sent += 1;
        await PushSubscription.updateOne(
          { _id: row._id },
          { $set: { lastUsedAt: new Date() } }
        );
      } catch (error) {
        const status = Number(error?.statusCode || 0);
        if (status === 404 || status === 410) {
          await PushSubscription.deleteOne({ _id: row._id });
          removed += 1;
        } else {
          console.error("[push] delivery failed:", error.message);
        }
      }
    })
  );

  return { configured: true, sent, removed };
}

module.exports = {
  configured,
  publicKey,
  saveSubscription,
  removeSubscription,
  sendToUser,
};
