const mongoose = require("mongoose");

const WalletTxSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: ["FUND", "DEBIT", "CREDIT"], required: true },
    amount: { type: Number, required: true },
    reference: { type: String, required: true, unique: true },
    status: { type: String, enum: ["PENDING", "SUCCESS", "FAILED"], default: "PENDING" },
    meta: { type: Object, default: {} }
  },
  { timestamps: true }
);

module.exports = mongoose.model("WalletTx", WalletTxSchema);
