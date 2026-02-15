const mongoose = require("mongoose");

// Unified transaction model (BuyBites 2.0)
// Covers DATA, AIRTIME, ELECTRICITY, TV, etc.

const TransactionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    type: {
      type: String,
      enum: ["DATA", "AIRTIME", "ELECTRICITY", "TV", "SAVINGS", "CARD", "OTHER"],
      required: true,
      index: true
    },

    provider: { type: String, default: "", index: true },
    amount: { type: Number, required: true },
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

    // Flexible payload (recipient phone, planCode, meterNo, smartcard, etc.)
    meta: { type: Object, default: {} },
  },
  { timestamps: true }
);

TransactionSchema.index({ userId: 1, createdAt: -1 });
TransactionSchema.index({ type: 1, status: 1, createdAt: -1 });
TransactionSchema.index({ userId: 1, idempotencyKey: 1 });

module.exports = mongoose.model("Transaction", TransactionSchema);
