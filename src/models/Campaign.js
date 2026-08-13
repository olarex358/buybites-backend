const mongoose = require("mongoose");

const CampaignSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", trim: true, maxlength: 240 },

    type: {
      type: String,
      enum: ["CASHBACK", "FIRST_PURCHASE", "SERVICE_BONUS", "AGENT_BONUS"],
      default: "CASHBACK",
      index: true,
    },

    rewardType: {
      type: String,
      enum: ["FIXED", "PERCENT"],
      default: "FIXED",
    },
    rewardValue: { type: Number, required: true, min: 0 },
    maxReward: { type: Number, default: 0, min: 0 },

    audience: {
      type: String,
      enum: ["ALL", "USER", "AGENT"],
      default: "ALL",
      index: true,
    },
    tier: {
      type: String,
      enum: ["ANY", "USER", "BASIC", "SILVER", "GOLD", "PLATINUM"],
      default: "ANY",
    },

    serviceTypes: {
      type: [String],
      default: ["DATA"],
    },

    minTransactionAmount: { type: Number, default: 0, min: 0 },

    // 0 = every qualifying transaction; 1 = once per user.
    perUserLimit: { type: Number, min: 0, default: 0 },

    budget: { type: Number, default: 0, min: 0 },
    budgetUsed: { type: Number, default: 0, min: 0 },
    totalClaims: { type: Number, default: 0, min: 0 },

    imageUrl: { type: String, default: "", trim: true, maxlength: 1000 },
    ctaText: { type: String, default: "Buy Now", trim: true, maxlength: 30 },
    ctaUrl: { type: String, default: "", trim: true, maxlength: 500 },

    priority: { type: Number, default: 0, min: 0, max: 100 },
    isActive: { type: Boolean, default: true, index: true },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },

    views: { type: Number, default: 0, min: 0 },
    clicks: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

CampaignSchema.index({ isActive: 1, audience: 1, priority: -1, startsAt: 1 });

module.exports = mongoose.model("Campaign", CampaignSchema);
