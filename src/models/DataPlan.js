const mongoose = require("mongoose");

const DataPlanSchema = new mongoose.Schema(
  {
    network: { type: String, required: true },
    plan_code: { type: String, required: true },
    title: { type: String, default: "" },
    sellPrice: { type: Number, required: true },
    costPrice: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

DataPlanSchema.index({ network: 1, plan_code: 1 }, { unique: true });

module.exports = mongoose.model("DataPlan", DataPlanSchema);
