const path = require("path");
const bcrypt = require("bcryptjs");
// Using absolute path mapping to prevent MODULE_NOT_FOUND on cPanel
const User = require(path.join(__dirname, "..", "models", "User"));

async function seedAdmin() {
  try {
    // Admin seeding is opt-in. Never ship or invent default credentials.
    const phone = String(process.env.SEED_ADMIN_PHONE || "").trim();
    const pin = String(process.env.SEED_ADMIN_PIN || "").trim();
    const name = String(process.env.SEED_ADMIN_NAME || "System Admin").trim();

    if (!phone || !/^\d{4,8}$/.test(pin)) {
      console.log("ℹ️ Admin seeding skipped: SEED_ADMIN_PHONE and a 4-8 digit SEED_ADMIN_PIN are not configured.");
      return;
    }

    const existing = await User.findOne({ phone });

    if (existing) {
      // Never reset or overwrite an existing administrator's credentials at startup.
      console.log("ℹ️ Seed admin already exists. Credentials were left unchanged.");
      return;
    }

    const pinHash = await bcrypt.hash(pin, 12);

    await User.create({
      phone,
      fullName: name,
      pinHash,
      role: "ADMIN",
      tier: "PLATINUM",
      isVerified: true,
      walletBalance: 0
    });

    console.log("🔥 Admin seeded successfully!");
  } catch (error) {
    // We throw the error so server.js can catch it and log it without crashing
    throw new Error(`Seed Error: ${error.message}`);
  }
}

module.exports = { seedAdmin };