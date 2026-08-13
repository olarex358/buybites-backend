const mongoose = require("mongoose");

const VirtualAccountSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    provider: { type: String, default: "KORAPAY", index: true },
    accountReference: { type: String, required: true, unique: true, index: true },
    providerUniqueId: { type: String, default: "" },
    accountNumber: { type: String, required: true },
    accountName: { type: String, default: "" },
    bankName: { type: String, default: "" },
    bankCode: { type: String, default: "" },
    currency: { type: String, default: "NGN" },
    status: {
      type: String,
      enum: ["PENDING", "ACTIVE", "SUSPENDED", "FAILED"],
      default: "ACTIVE",
      index: true,
    },
    meta: { type: Object, default: {} },
  },
  { timestamps: true }
);

VirtualAccountSchema.index({ userId: 1, provider: 1 });
VirtualAccountSchema.index({ accountNumber: 1 });

module.exports = mongoose.model("VirtualAccount", VirtualAccountSchema);
