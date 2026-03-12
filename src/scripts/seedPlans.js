/**
 * scripts/seedPlans.js
 * ─────────────────────────────────────────────
 * One-time script to pull plans from Peyflex
 * and seed them into your MongoDB DataPlan collection.
 *
 * HOW TO RUN:
 *   node scripts/seedPlans.js
 *
 * Make sure your .env is set (MONGO_URI + PEYFLEX_BASE_URL + PEYFLEX_TOKEN)
 * ─────────────────────────────────────────────
 */

require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });
const mongoose = require("mongoose");
const axios    = require("axios");
const DataPlan = require("./models/DataPlan");

const NETWORKS = ["mtn", "glo", "airtel", "9mobile"];

const NETWORK_MAP = {
  mtn:      "mtn_sme_data",
  glo:      "glo_sme_data",
  airtel:   "airtel_sme_data",
  "9mobile":"9mobile_sme_data",
  etisalat: "9mobile_sme_data",
};

function peyflexClient() {
  return axios.create({
    baseURL: process.env.PEYFLEX_BASE_URL,
    headers: {
      Authorization: `Token ${process.env.PEYFLEX_TOKEN}`,
      "Content-Type": "application/json",
    },
    timeout: 25000,
  });
}

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ MongoDB connected");

  const api = peyflexClient();
  let total = 0;

  for (const net of NETWORKS) {
    try {
      console.log(`\n📡 Fetching plans for ${net.toUpperCase()}...`);
      const r = await api.get(`/api/data/plans/?network=${encodeURIComponent(net)}`);
      const raw = r.data;

      const list = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.results) ? raw.results
        : Array.isArray(raw?.plans)   ? raw.plans
        : Array.isArray(raw?.data)    ? raw.data
        : [];

      console.log(`   Found ${list.length} plans from Peyflex`);

      // Log first item so you can see the field names Peyflex uses
      if (list.length > 0) {
        console.log("   Sample plan fields:", Object.keys(list[0]).join(", "));
        console.log("   Sample plan:", JSON.stringify(list[0], null, 2));
      }

      let synced = 0;
      for (const item of list) {
        const plan_code  = String(item.plan_code || item.code || item.id || "").trim();
        const title      = String(item.name || item.title || item.description || plan_code).trim();
        const sellPrice  = Number(item.price || item.amount || item.selling_price || 0);
        const costPrice  = Number(item.cost_price || item.cost || 0);
        const network_key = NETWORK_MAP[String(item.network || net).toLowerCase()] || net;

        if (!plan_code || !sellPrice) {
          console.log("   ⚠️  Skipped (missing plan_code or price):", item);
          continue;
        }

        await DataPlan.findOneAndUpdate(
          { network: network_key, plan_code },
          { network: network_key, plan_code, title, sellPrice, costPrice, isActive: true },
          { upsert: true, new: true }
        );
        synced++;
      }

      console.log(`   ✅ Synced ${synced} plans for ${net.toUpperCase()}`);
      total += synced;
    } catch (e) {
      console.error(`   ❌ Failed for ${net}:`, e?.response?.data || e.message);
    }
  }

  console.log(`\n🎉 Done! Total plans seeded: ${total}`);
  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});