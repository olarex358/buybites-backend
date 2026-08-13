const mongoose = require("mongoose");

const NotificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, default: "GENERAL", index: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    txId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction", default: null, index: true },
    priority: {
      type: String,
      enum: ["NORMAL", "IMPORTANT", "CRITICAL"],
      default: "NORMAL",
      index: true,
    },
    actionUrl: { type: String, default: "" },
    meta: { type: Object, default: {} },
    smsSentAt: { type: Date, default: null },
    smsStatus: { type: String, default: "" },
    dedupeKey: { type: String, required: true, unique: true, index: true },
    readAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", NotificationSchema);
