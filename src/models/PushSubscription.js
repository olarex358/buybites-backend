const mongoose = require("mongoose");

const PushSubscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    endpoint: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    subscription: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    userAgent: { type: String, default: "" },
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

PushSubscriptionSchema.index({ userId: 1, updatedAt: -1 });

module.exports = mongoose.model("PushSubscription", PushSubscriptionSchema);
