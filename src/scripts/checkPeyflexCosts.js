require("dotenv").config();

const mongoose = require("mongoose");
const axios = require("axios");
const DataPlan = require("../models/DataPlan");

const NETWORKS = [
  "mtn_gifting_data",
  "glo_data",
  "airtel_data",
  "9mobile_data",
  "mtn_data_share",
];
function peyflexClient() {
  return axios.create({
    baseURL: process.env.PEYFLEX_BASE_URL,
    headers: {
      Authorization: `Token ${process.env.PEYFLEX_TOKEN}`,
      "Content-Type": "application/json",
    },
    timeout: 30000,
  });
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  console.log("✅ MongoDB connected\n");

  const api = peyflexClient();

  for (const network of NETWORKS) {
    console.log(`\n========== ${network} ==========`);

    try {
      const response = await api.get("/api/data/plans/", {
        params: { network },
      });

      const plans = Array.isArray(response.data?.plans)
        ? response.data.plans
        : [];

      console.log(`Peyflex returned: ${plans.length} plans`);

      for (const pf of plans) {
        const planCode = String(pf.plan_code || "").trim();
        const peyflexAmount = Number(pf.amount || 0);

        if (!planCode) continue;

        const local = await DataPlan.findOne({
          plan_code: planCode,
        }).lean();

        if (!local) {
          console.log(
            `❌ NOT FOUND | ${planCode} | Peyflex ₦${peyflexAmount}`
          );
          continue;
        }

        console.log(
          `✅ ${planCode} | Sell ₦${local.sellPrice} | Peyflex ₦${peyflexAmount} | DB Cost ₦${local.costPrice || 0}`
        );
      }
    } catch (err) {
      console.log(
        `❌ ${network} failed:`,
        err.response?.data || err.message
      );
    }
  }

  await mongoose.disconnect();
  console.log("\n✅ Check complete. NOTHING was changed.");
}

run().catch((err) => {
  console.error("❌ Script failed:", err);
  process.exit(1);
});