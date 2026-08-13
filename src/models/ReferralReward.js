const mongoose = require("mongoose");

const ReferralRewardSchema = new mongoose.Schema(
  {
    referrerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    referredUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction", required: true, unique: true, index: true },
    referrerAmount: { type: Number, default: 0 },
    refereeAmount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["PAID", "SKIPPED", "FAILED"],
      default: "PAID",
      index: true,
    },
    reason: { type: String, default: "" },
  },
  { timestamps: true }
);

ReferralRewardSchema.index({ referrerId: 1, createdAt: -1 });
ReferralRewardSchema.index({ referredUserId: 1, createdAt: -1 });

module.exports = mongoose.model("ReferralReward", ReferralRewardSchema);
