const mongoose = require("mongoose");

// ── Referral code generator ──────────────────────────────────
// Format: BB-XXXXXX (6 uppercase alphanumeric chars)
function genReferralCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0,O,1,I (confusing)
  let code = "BB-";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

const UserSchema = new mongoose.Schema(
  {
    phone:    { type: String, unique: true, required: true, trim: true },
    pinHash:  { type: String, required: true },
    fullName: { type: String, default: "", trim: true },

    // Wallet
    walletBalance: { type: Number, default: 0 },

    // Role / tier
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

    totalVolume: { type: Number, default: 0 },
    totalProfit: { type: Number, default: 0 },

    // ✅ Referral system
    referralCode: {
      type: String,
      unique: true,
      sparse: true,   // allows multiple null values
      default: genReferralCode,
    },
    referredBy: {
      type: String,   // stores the referralCode of who referred this user
      default: null,
    },
    referralBonusPaid: { type: Boolean, default: false },

    // Security
    isBlocked:          { type: Boolean, default: false },
    failedLoginAttempts:{ type: Number,  default: 0 },
    lockUntil:          { type: Date,    default: null },
    isVerified:         { type: Boolean, default: false },

    // Device binding
    deviceId:     { type: String, default: null },
    deviceBoundAt:{ type: Date,   default: null },
  },
  { timestamps: true }
);

UserSchema.index({ phone: 1 });
UserSchema.index({ referralCode: 1 });
UserSchema.index({ referredBy: 1 });

module.exports = mongoose.model("User", UserSchema);