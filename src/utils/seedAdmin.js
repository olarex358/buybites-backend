const User = require("../models/User");
const { cleanPhone } = require("./phone"); // you already have phone utils

async function seedAdmin() {
  const phoneRaw = process.env.SEED_ADMIN_PHONE;
  const pin = process.env.SEED_ADMIN_PIN;
  const name = process.env.SEED_ADMIN_NAME || "Admin";

  if (!phoneRaw || !pin) return;

  const phone = cleanPhone(phoneRaw) || phoneRaw;
  const exists = await User.findOne({ role: "ADMIN" }).select("_id");
  if (exists) return;

  // If your User model hashes pin in pre-save, this is safe.
  // If you hash pin manually elsewhere, paste User.js and I’ll align it.
  await User.create({
    phone,
    pin,
    name,
    role: "ADMIN",
    tier: "PLATINUM",
    isActive: true,
  });

  console.log("✅ Seed admin created:", phone);
}

module.exports = { seedAdmin };