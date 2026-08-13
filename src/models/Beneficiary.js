const mongoose = require("mongoose");

const BeneficiarySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    bankCode: { type: String, required: true, trim: true },
    bankName: { type: String, default: "", trim: true },
    accountNumber: { type: String, required: true, trim: true },
    accountName: { type: String, required: true, trim: true },
    label: { type: String, default: "", trim: true, maxlength: 60 },
    verifiedAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

BeneficiarySchema.index(
  { userId: 1, bankCode: 1, accountNumber: 1 },
  { unique: true }
);

module.exports = mongoose.model("Beneficiary", BeneficiarySchema);
