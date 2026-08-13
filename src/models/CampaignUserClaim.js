const mongoose = require("mongoose");

const CampaignUserClaimSchema = new mongoose.Schema(
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
    claims: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
  },
  { timestamps: true }
);

CampaignUserClaimSchema.index(
  { campaignId: 1, userId: 1 },
  { unique: true }
);

module.exports = mongoose.model("CampaignUserClaim", CampaignUserClaimSchema);
