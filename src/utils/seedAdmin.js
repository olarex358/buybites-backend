const bcrypt = require("bcryptjs");
const User = require("../models/user.model");

async function seedAdmin() {
  const phone = process.env.SEED_ADMIN_PHONE;
  const pin = process.env.SEED_ADMIN_PIN;
  const name = process.env.SEED_ADMIN_NAME || "Admin";

  // If no env values provided, skip silently
  if (!phone || !pin) {
    console.log("⚠️ Admin seed skipped (no env provided)");
    return;
  }

  const existing = await User.findOne({ phone });
  if (existing) {
    console.log("✅ Admin already exists");
    return;
  }

  const pinHash = await bcrypt.hash(pin, 10);

  await User.create({
    phone,
    fullName: name,
    pinHash,
    role: "ADMIN",
    tier: "PLATINUM",
  });

  console.log("🔥 Admin seeded successfully");
}

module.exports = { seedAdmin };