const mongoose = require("mongoose");

const OrderSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    network: { type: String, required: true },
    mobile_number: { type: String, required: true },
    plan_code: { type: String, required: true },
    amount: { type: Number, required: true },
    status: {
      type: String,
      enum: ["PROCESSING", "DELIVERED", "FAILED", "REFUNDED"],
      default: "PROCESSING"
    },
    providerRef: { type: String, default: "" },
    retries: { type: Number, default: 0 },
    lastError: { type: String, default: "" }
  },
  
  { timestamps: true }
  
);

OrderSchema.index({ status: 1, createdAt: -1 });
OrderSchema.index({ mobile_number: 1 });

module.exports = mongoose.model("Order", OrderSchema);
