const Notification = require("../models/Notification");
const User = require("../models/User");
const { sendToUser } = require("./push.service");
const {
  sendCriticalTransactionSms,
  transactionSmsConfigured,
} = require("./sms.service");

function detailsFor(tx, status) {
  const type = String(tx.type || "TRANSACTION").replace(/_/g, " ");
  const label = type.charAt(0) + type.slice(1).toLowerCase();

  if (status === "SUCCESS") {
    return {
      type: "TRANSACTION_SUCCESS",
      priority: "IMPORTANT",
      title: `${label} successful 🎉`,
      message:
        tx.statusMessage ||
        `${label} transaction ${tx.reference} was completed successfully.`,
    };
  }

  if (status === "REFUNDED") {
    return {
      type: "TRANSACTION_REFUNDED",
      priority: "CRITICAL",
      title: `${label} refunded`,
      message:
        tx.statusMessage ||
        `Your ${label.toLowerCase()} transaction was not completed. Your wallet has been refunded.`,
    };
  }

  if (status === "FAILED") {
    return {
      type: "TRANSACTION_FAILED",
      priority: "CRITICAL",
      title: `${label} failed`,
      message:
        tx.statusMessage ||
        tx.lastError ||
        `Your ${label.toLowerCase()} transaction could not be completed.`,
    };
  }

  return {
    type: "TRANSACTION_PROCESSING",
    priority: "NORMAL",
    title: `${label} still processing`,
    message:
      tx.statusMessage ||
      `Your ${label.toLowerCase()} transaction is still being processed. Please don't purchase again.`,
  };
}

async function notifyTransactionStatus(tx, status) {
  const details = detailsFor(tx, status);

  return notify({
    userId: tx.userId,
    type: details.type,
    title: details.title,
    message: details.message,
    txId: tx._id,
    priority: details.priority,
    actionUrl: "/tx",
    dedupeKey: `TX_STATUS:${tx._id}:${status}`,
  });
}

function isCriticalSmsNotification(type, priority) {
  return (
    priority === "CRITICAL" ||
    type === "TRANSACTION_SUCCESS" ||
    type === "TRANSACTION_REFUNDED" ||
    type === "TRANSACTION_REVIEW"
  );
}

async function sendSmsOnce({ notification, user, title, message }) {
  if (!notification || !user) return;
  if (!transactionSmsConfigured()) return;
  if (!user.notificationPreferences?.smsCritical) return;
  if (!isCriticalSmsNotification(notification.type, notification.priority)) return;
  if (notification.smsSentAt) return;

  // Claim this notification's SMS slot. If another process already claimed it,
  // do not send a duplicate SMS.
  const claimed = await Notification.findOneAndUpdate(
    { _id: notification._id, smsSentAt: null },
    { $set: { smsStatus: "SENDING" } },
    { new: true }
  );

  if (!claimed) return;

  try {
    await sendCriticalTransactionSms({
      to: user.phone,
      title,
      message,
    });

    await Notification.updateOne(
      { _id: notification._id },
      { $set: { smsSentAt: new Date(), smsStatus: "SENT" } }
    );
  } catch (error) {
    await Notification.updateOne(
      { _id: notification._id },
      {
        $set: {
          smsStatus: String(error?.message || "SMS delivery failed").slice(0, 300),
        },
      }
    );

    console.error("[sms] critical notification failed:", error.message);
  }
}

async function notify({
  userId,
  type = "GENERAL",
  title,
  message,
  txId = null,
  priority = "NORMAL",
  actionUrl = "",
  meta = {},
  dedupeKey,
}) {
  if (!userId || !title || !message || !dedupeKey) return null;

  try {
    // First check avoids re-sending push/SMS whenever a lifecycle retry hits
    // the same dedupe key.
    const existing = await Notification.findOne({ dedupeKey });
    if (existing) return existing;

    const saved = await Notification.create({
      userId,
      type,
      title,
      message,
      txId,
      priority,
      actionUrl,
      meta,
      dedupeKey,
    });

    const user = await User.findById(userId)
      .select("phone notificationPreferences")
      .lean();

    const pushAllowed =
      user?.notificationPreferences?.transactionUpdates !== false;

    if (pushAllowed) {
      sendToUser({
        userId,
        title,
        message,
        data: {
          txId: txId ? String(txId) : "",
          type,
          priority,
          url: actionUrl || (txId ? "/tx" : "/home"),
        },
      }).catch((error) => {
        console.error("[push] notification error:", error.message);
      });
    }

    // SMS is explicitly opt-in and only used for important transaction events.
    sendSmsOnce({
      notification: saved,
      user,
      title,
      message,
    }).catch((error) => {
      console.error("[sms] notification error:", error.message);
    });

    return saved;
  } catch (error) {
    // A concurrent lifecycle worker may have created the same notification.
    if (error?.code === 11000) {
      return Notification.findOne({ dedupeKey });
    }
    throw error;
  }
}

module.exports = { notifyTransactionStatus, notify };
