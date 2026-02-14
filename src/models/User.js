const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    phone: { type: String, unique: true, required: true, trim: true },
    pinHash: { type: String, required: true }, // secure phone-only login
    fullName: { type: String, default: "", trim: true },
    walletBalance: { type: Number, default: 0 },
    isBlocked: { type: Boolean, default: false },
    failedLoginAttempts: { type: Number, default: 0 },
lockUntil: { type: Date, default: null },
isVerified: { type: Boolean, default: false },
deviceId: { type: String, default: null },
deviceBoundAt: { type: Date, default: null },


  },
  { timestamps: true }
);

UserSchema.index({ phone: 1 });

module.exports = mongoose.model("User", UserSchema);
