const mongoose = require("mongoose");

const LoyaltyLedgerSchema = new mongoose.Schema(
  {
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
      unique: true,
      index: true,
    },
    points: { type: Number, required: true, min: 0 },
    reason: { type: String, default: "Successful transaction" },
    reference: { type: String, required: true, unique: true, index: true },
  },
  { timestamps: true }
);

LoyaltyLedgerSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("LoyaltyLedger", LoyaltyLedgerSchema);
