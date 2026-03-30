const mongoose = require("mongoose");

const WalletTxSchema = new mongoose.Schema(
  {
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type:      { type: String, enum: ["FUND", "DEBIT", "CREDIT", "REFUND"], required: true },
    amount:    { type: Number, required: true },
    reference: { type: String, required: true, unique: true },
    status:    { type: String, enum: ["PENDING", "SUCCESS", "FAILED"], default: "PENDING" },
    provider:  { type: String, default: "" },
    meta:      { type: Object, default: {} },
  },
  { timestamps: true }
);

WalletTxSchema.index({ userId: 1, createdAt: -1 });
WalletTxSchema.index({ reference: 1 });

module.exports = mongoose.model("WalletTx", WalletTxSchema);
