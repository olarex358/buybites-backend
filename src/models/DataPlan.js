const mongoose = require("mongoose");

const DataPlanSchema = new mongoose.Schema(
  {
    network: { type: String, required: true },
    plan_code: { type: String, required: true },
    title: { type: String, default: "" },
    sellPrice: { type: Number, required: true },
    costPrice: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },

    // Which provider delivers this plan
    provider: {
      type: String,
      enum: ["PEYFLEX", "SMEDATA"],
      default: "PEYFLEX",
    },

    // Network identifier sent to provider
    // Peyflex: mtn_gifting_data | SMEData: mtn
    peyflexNetwork: { type: String, default: "" },

    // Tier-specific prices set by admin
    tierPrices: {
      USER: { type: Number, default: 0 },
      BASIC: { type: Number, default: 0 },
      SILVER: { type: Number, default: 0 },
      GOLD: { type: Number, default: 0 },
      PLATINUM: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

DataPlanSchema.index({ network: 1, plan_code: 1 }, { unique: true });
DataPlanSchema.index({ provider: 1, isActive: 1 });

module.exports = mongoose.model("DataPlan", DataPlanSchema);
