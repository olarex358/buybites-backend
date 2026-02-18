const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    phone: { type: String, unique: true, required: true, trim: true },
    pinHash: { type: String, required: true },

    fullName: { type: String, default: "", trim: true },

    // Wallet
    walletBalance: { type: Number, default: 0 },

    // Agent/Reseller upgrade ✅
    role: {
      type: String,
      enum: ["USER", "AGENT", "ADMIN"],
      default: "USER",
      index: true,
    },
    tier: {
      type: String,
      enum: ["USER", "BASIC", "SILVER", "GOLD", "PLATINUM"],
      default: "USER",
      index: true,
    },
    totalVolume: { type: Number, default: 0 }, // total sales amount (SUCCESS only)
    totalProfit: { type: Number, default: 0 }, // total profit (SUCCESS only)

    // Security
    isBlocked: { type: Boolean, default: false },
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
    isVerified: { type: Boolean, default: false },

    // Device binding
    deviceId: { type: String, default: null },
    deviceBoundAt: { type: Date, default: null },
  },
  { timestamps: true }
);

UserSchema.index({ phone: 1 });

module.exports = mongoose.model("User", UserSchema);
