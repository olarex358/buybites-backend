const mongoose = require("mongoose");

const StreakLedgerSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    activityDate: {
      type: String, // YYYY-MM-DD in NEX_STREAK_TZ
      required: true,
    },
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },
    transactionReference: {
      type: String,
      default: "",
    },
    serviceType: {
      type: String,
      default: "",
    },
    currentStreak: {
      type: Number,
      default: 1,
      min: 1,
    },
    longestStreak: {
      type: Number,
      default: 1,
      min: 1,
    },
    milestoneNotified: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

StreakLedgerSchema.index({ userId: 1, activityDate: 1 }, { unique: true });
StreakLedgerSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("StreakLedger", StreakLedgerSchema);
