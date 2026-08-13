const mongoose = require("mongoose");

const TransactionEventSchema = new mongoose.Schema(
  {
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["PROCESSING", "SUCCESS", "FAILED", "REFUNDED"],
      required: true,
    },
    processingStage: {
      type: String,
      default: "",
      index: true,
    },
    message: { type: String, default: "" },
    source: {
      type: String,
      enum: ["SYSTEM", "PROVIDER", "WEBHOOK", "REQUERY", "ADMIN"],
      default: "SYSTEM",
    },
    providerRef: { type: String, default: "" },
    meta: { type: Object, default: {} },
  },
  { timestamps: true }
);

TransactionEventSchema.index({ transactionId: 1, createdAt: 1 });
TransactionEventSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("TransactionEvent", TransactionEventSchema);
