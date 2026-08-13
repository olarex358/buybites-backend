const mongoose = require("mongoose");

const ProviderFundingSchema = new mongoose.Schema(
  {
    reference: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    provider: {
      type: String,
      default: "PEYFLEX",
      enum: ["PEYFLEX"],
      index: true,
    },

    fundingProvider: {
      type: String,
      default: "KORAPAY",
      enum: ["KORAPAY"],
    },

    amount: {
      type: Number,
      required: true,
      min: 1,
    },

    peyflexBalanceBefore: {
      type: Number,
      required: true,
      min: 0,
    },

    targetBalance: {
      type: Number,
      required: true,
      min: 0,
    },

    status: {
      type: String,enum: [
  "PENDING",
  "APPROVED",
  "PROCESSING",
  "SUCCESS",
  "FAILED",
  "CANCELLED",
],
      default: "PENDING",
      index: true,
    },

    korapayReference: {
      type: String,
      default: "",
      index: true,
    },

    destinationAccount: {
      type: String,
      default: "",
    },

    destinationBankCode: {
      type: String,
      default: "",
    },
    destinationBankName: {
  type: String,
  default: "",
    },

  destinationAccountName: {
  type: String,
  default: "",
  },
    narration: {
      type: String,
      default: "",
    },

    failureReason: {
      type: String,
      default: "",
    },

    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    approvedAt: {
      type: Date,
      default: null,
    },

    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

ProviderFundingSchema.index({
  status: 1,
  createdAt: -1,
});

module.exports = mongoose.model(
  "ProviderFunding",
  ProviderFundingSchema
);