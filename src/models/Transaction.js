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

    // NEX transaction lifecycle metadata. The public status stays simple while
    // processingStage tells the UI/admin system exactly what is happening.
    processingStage: {
      type: String,
      default: "CREATED",
      index: true
    },
    statusMessage: { type: String, default: "" },
    providerRef: { type: String, default: "" },
    retries: { type: Number, default: 0 },
    requeryAttempts: { type: Number, default: 0 },
    lastError: { type: String, default: "" },
    lastProviderAttemptAt: { type: Date, default: null },
    lastRequeryAt: { type: Date, default: null },
    nextCheckAt: { type: Date, default: null, index: true },
    manualReviewAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    processingLockId: { type: String, default: "" },
    processingLockedAt: { type: Date, default: null },

    // Flexible payload
    meta: { type: Object, default: {} },
  },
  { timestamps: true }
);

TransactionSchema.index({ userId: 1, createdAt: -1 });
TransactionSchema.index({ type: 1, status: 1, createdAt: -1 });
TransactionSchema.index({ status: 1, processingStage: 1, createdAt: 1 });
TransactionSchema.index({ userId: 1, idempotencyKey: 1 });

module.exports = mongoose.model("Transaction", TransactionSchema);
