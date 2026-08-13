const mongoose = require("mongoose");

const WalletFundingEventSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    walletTxId: { type: mongoose.Schema.Types.ObjectId, ref: "WalletTx", default: null, index: true },
    provider: { type: String, required: true, uppercase: true, index: true },
    event: { type: String, required: true, index: true },
    reference: { type: String, required: true, index: true },
    amount: { type: Number, default: 0 },
    status: { type: String, default: "" },
    source: {
      type: String,
      enum: ["CHECKOUT", "WEBHOOK", "REQUERY", "ADMIN"],
      default: "WEBHOOK",
    },
    meta: { type: Object, default: {} },
  },
  { timestamps: true }
);

WalletFundingEventSchema.index({ provider: 1, reference: 1, event: 1, createdAt: -1 });

module.exports = mongoose.model("WalletFundingEvent", WalletFundingEventSchema);
