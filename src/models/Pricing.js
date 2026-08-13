const mongoose = require("mongoose");

const PricingSchema = new mongoose.Schema(
  {
    serviceType: {
      type: String,
      enum: ["DATA", "AIRTIME", "ELECTRICITY", "TV", "PIN", "BETTING"],
      required: true,
      index: true,
    },

    network: { type: String, default: "", index: true },
    productCode: { type: String, default: "", index: true },

    // MANUAL = explicit tier prices.
    // COST_PLUS = calculate missing tier prices from provider cost + margin.
    pricingMode: {
      type: String,
      enum: ["MANUAL", "COST_PLUS"],
      default: "MANUAL",
      index: true,
    },

    prices: {
      USER: { type: Number, default: 0 },
      BASIC: { type: Number, default: 0 },
      SILVER: { type: Number, default: 0 },
      GOLD: { type: Number, default: 0 },
      PLATINUM: { type: Number, default: 0 },
    },

    // Provider cost snapshot for fixed-price products.
    baseCost: { type: Number, default: 0 },

    // COST_PLUS controls.
    marginPercent: { type: Number, default: 0, min: 0, max: 100 },
    fixedFee: { type: Number, default: 0, min: 0 },
    minProfit: { type: Number, default: 0, min: 0 },
    roundingUnit: { type: Number, default: 1, min: 1 },

    // If true and a manual price is below cost + minimum profit,
    // NEX refuses the sale instead of silently losing money.
    enforceProfitFloor: { type: Boolean, default: true },

    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

PricingSchema.index(
  { serviceType: 1, network: 1, productCode: 1 },
  { unique: true }
);

module.exports = mongoose.model("Pricing", PricingSchema);
