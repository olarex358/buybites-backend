const router = require("express").Router();
const { z } = require("zod");
const { auth } = require("../middleware/auth");
const Notification = require("../models/Notification");
const User = require("../models/User");
const push = require("../services/push.service");
const { transactionSmsConfigured } = require("../services/sms.service");


// ── GET /api/notifications/push/public-key ─────────────────────
router.get("/push/public-key", auth, async (req, res) => {
  const key = push.publicKey();
  if (!key) {
    return res.status(503).json({
      ok: false,
      error: "Push notifications are not configured on this server.",
      code: "PUSH_NOT_CONFIGURED",
    });
  }

  return res.success({ publicKey: key }, "Push configuration fetched");
});

// ── POST /api/notifications/push/subscribe ────────────────────
router.post("/push/subscribe", auth, async (req, res, next) => {
  try {
    const subscription = req.body?.subscription;
    const saved = await push.saveSubscription({
      userId: req.user.sub,
      subscription,
      userAgent: req.headers["user-agent"] || "",
    });

    return res.success(
      { enabled: true, id: saved._id },
      "Push notifications enabled"
    );
  } catch (e) {
    next(e);
  }
});

// ── DELETE /api/notifications/push/subscribe ──────────────────
router.delete("/push/subscribe", auth, async (req, res, next) => {
  try {
    await push.removeSubscription({
      userId: req.user.sub,
      endpoint: req.body?.endpoint,
    });

    return res.success({ enabled: false }, "Push subscription removed");
  } catch (e) {
    next(e);
  }
});

// ── GET /api/notifications/preferences ────────────────────────
router.get("/preferences", auth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.sub)
      .select("notificationPreferences")
      .lean();

    const preferences = user?.notificationPreferences || {};

    return res.success(
      {
        transactionUpdates: preferences.transactionUpdates !== false,
        smsCritical: preferences.smsCritical === true,
        smsAvailable: transactionSmsConfigured(),
      },
      "Notification preferences fetched"
    );
  } catch (e) {
    next(e);
  }
});

// ── PUT /api/notifications/preferences ────────────────────────
router.put("/preferences", auth, async (req, res, next) => {
  try {
    const transactionUpdates =
      req.body?.transactionUpdates === undefined
        ? true
        : Boolean(req.body.transactionUpdates);

    const smsCritical =
      req.body?.smsCritical === undefined
        ? false
        : Boolean(req.body.smsCritical);

    const saved = await User.findByIdAndUpdate(
      req.user.sub,
      {
        $set: {
          "notificationPreferences.transactionUpdates": transactionUpdates,
          "notificationPreferences.smsCritical": smsCritical,
        },
      },
      { new: true }
    )
      .select("notificationPreferences")
      .lean();

    return res.success(
      {
        transactionUpdates:
          saved?.notificationPreferences?.transactionUpdates !== false,
        smsCritical: saved?.notificationPreferences?.smsCritical === true,
        smsAvailable: transactionSmsConfigured(),
      },
      "Notification preferences updated"
    );
  } catch (e) {
    next(e);
  }
});

router.get("/", auth, async (req, res, next) => {
  try {
    const q = z.object({ limit: z.string().optional() }).passthrough().parse(req.query);
    const limit = Math.min(Math.max(parseInt(q.limit || "30", 10), 1), 100);

    const notifications = await Notification.find({ userId: req.user.sub })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const unreadCount = await Notification.countDocuments({
      userId: req.user.sub,
      readAt: null,
    });

    return res.success({ notifications, unreadCount }, "Notifications fetched");
  } catch (e) {
    next(e);
  }
});

router.get("/unread-count", auth, async (req, res, next) => {
  try {
    const unreadCount = await Notification.countDocuments({
      userId: req.user.sub,
      readAt: null,
    });
    return res.success({ unreadCount }, "Unread count fetched");
  } catch (e) {
    next(e);
  }
});

router.post("/read-all", auth, async (req, res, next) => {
  try {
    await Notification.updateMany(
      { userId: req.user.sub, readAt: null },
      { $set: { readAt: new Date() } }
    );
    return res.success({}, "Notifications marked as read");
  } catch (e) {
    next(e);
  }
});

router.post("/:id/read", auth, async (req, res, next) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.sub },
      { $set: { readAt: new Date() } },
      { new: true }
    );

    if (!notification) return res.fail("Notification not found", 404);
    return res.success({ notification }, "Notification marked as read");
  } catch (e) {
    next(e);
  }
});

module.exports = router;
