const mongoose = require("mongoose");

// Unified transaction model (BuyBites 2.0+)
// Covers DATA, AIRTIME, ELECTRICITY, TV, etc.

const TransactionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    type: {
      type: String,
      enum: ["DATA", "AIRTIME", "ELECTRICITY", "TV", "CABLE", "EXAM_PIN", "AIRTIME_TO_CASH", "SAVINGS", "CARD", "OTHER"],
      required: true,
      index: true
    },

    provider: { type: String, default: "", index: true },

    // 💰 Pricing fields (Agent/Reseller-ready) ✅
    tierAtPurchase: {
      type: String,
      enum: ["USER", "BASIC", "SILVER", "GOLD", "PLATINUM"],
      default: "USER",
      index: true
    },
    sellPrice: { type: Number, required: true },   // what we charged the user
    baseCost: { type: Number, default: 0 },        // your internal cost (optional)
    profit: { type: Number, default: 0 },          // sellPrice - baseCost

    // Backward compatibility
    amount: { type: Number, required: true }, // keep using amount as "charged amount"
    fee: { type: Number, default: 0 },

    reference: { type: String, required: true, unique: true, index: true },
    idempotencyKey: { type: String, default: "", index: true },

    status: {
      type: String,
      enum: ["PROCESSING", "SUCCESS", "FAILED", "REFUNDED"],
      default: "PROCESSING",
      index: true
    },

    providerRef: { type: String, default: "" },
    retries: { type: Number, default: 0 },
    lastError: { type: String, default: "" },

    // Flexible payload
    meta: { type: Object, default: {} },
  },
  { timestamps: true }
);

TransactionSchema.index({ userId: 1, createdAt: -1 });
TransactionSchema.index({ type: 1, status: 1, createdAt: -1 });
TransactionSchema.index({ userId: 1, idempotencyKey: 1 });

module.exports = mongoose.model("Transaction", TransactionSchema);
