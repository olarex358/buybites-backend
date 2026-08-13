const mongoose = require("mongoose");

const CampaignRewardSchema = new mongoose.Schema(
  {
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      required: true,
      index: true,
    },
    amount: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ["PAID", "FAILED"],
      default: "PAID",
      index: true,
    },
    claimKey: { type: String, required: true, unique: true, index: true },
    reason: { type: String, default: "" },
  },
  { timestamps: true }
);

CampaignRewardSchema.index({ campaignId: 1, createdAt: -1 });
CampaignRewardSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("CampaignReward", CampaignRewardSchema);
