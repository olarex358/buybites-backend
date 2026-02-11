const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    phone: { type: String, unique: true, required: true, trim: true },
    pinHash: { type: String, required: true }, // secure phone-only login
    fullName: { type: String, default: "", trim: true },
    walletBalance: { type: Number, default: 0 },
    isBlocked: { type: Boolean, default: false }
  },
  { timestamps: true }
);

UserSchema.index({ phone: 1 });

module.exports = mongoose.model("User", UserSchema);
