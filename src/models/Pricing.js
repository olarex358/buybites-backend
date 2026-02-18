const mongoose = require("mongoose");

const PricingSchema = new mongoose.Schema(
  {
    serviceType: {
      type: String,
      enum: ["DATA", "AIRTIME", "ELECTRICITY", "TV", "PIN", "BETTING"],
      required: true,
      index: true,
    },

    network: { type: String, default: "", index: true },      // e.g. MTN / GLO / AEDC / DSTV
    productCode: { type: String, default: "", index: true },  // e.g. plan_code / package_id

    // manual tier pricing ✅
    prices: {
      USER: { type: Number, default: 0 },
      BASIC: { type: Number, default: 0 },
      SILVER: { type: Number, default: 0 },
      GOLD: { type: Number, default: 0 },
      PLATINUM: { type: Number, default: 0 },
    },

    // optional: override cost too
    baseCost: { type: Number, default: 0 },

    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

PricingSchema.index({ serviceType: 1, network: 1, productCode: 1 }, { unique: true });

module.exports = mongoose.model("Pricing", PricingSchema);
