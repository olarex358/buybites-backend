const mongoose = require("mongoose");

// ── Referral code generator ──────────────────────────────────
// Format: NEX-XXXXXX (6 uppercase alphanumeric chars)
function genReferralCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0,O,1,I (confusing)
  let code = "NEX-";
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

    // Loyalty is intentionally separate from pricing tier.
    loyaltyPoints: { type: Number, default: 0, min: 0, index: true },
    lifetimePoints: { type: Number, default: 0, min: 0, index: true },
    loyaltyLevel: {
      type: String,
      enum: ["STARTER", "RISING", "PLUS", "PRO", "VIP", "ELITE"],
      default: "STARTER",
      index: true,
    },

    // Agent rank is based on successful sales volume, not the pricing tier.
    agentRank: {
      type: String,
      enum: ["BRONZE", "SILVER", "GOLD", "PLATINUM", "ELITE"],
      default: "BRONZE",
      index: true,
    },

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

    // Notification preferences.
    // Push is controlled by the browser subscription; smsCritical is opt-in
    // and only used when NEX has a configured SMS provider.
    notificationPreferences: {
      transactionUpdates: { type: Boolean, default: true },
      smsCritical: { type: Boolean, default: false },
    },

    // Security
    isBlocked:          { type: Boolean, default: false },
    failedLoginAttempts:{ type: Number,  default: 0 },
    lockUntil:          { type: Date,    default: null },
    isVerified:         { type: Boolean, default: false },
    lastActiveAt:       { type: Date, default: null, index: true },

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