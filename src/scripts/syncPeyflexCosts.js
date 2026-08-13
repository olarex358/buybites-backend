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

  let totalFetched = 0;
  let totalUpdated = 0;
  let totalMissing = 0;

  for (const peyflexNetwork of NETWORKS) {
    console.log(
      `\n========== ${peyflexNetwork} ==========`
    );

    try {
      const response = await api.get(
        "/api/data/plans/",
        {
          params: {
            network: peyflexNetwork,
          },
        }
      );

      const plans = Array.isArray(
        response.data?.plans
      )
        ? response.data.plans
        : [];

      totalFetched += plans.length;

      console.log(
        `Peyflex returned: ${plans.length} plans`
      );

      for (const pf of plans) {
        const planCode = String(
          pf.plan_code || ""
        ).trim();

        const peyflexAmount = Number(
          pf.amount
        );

        if (
          !planCode ||
          !Number.isFinite(peyflexAmount) ||
          peyflexAmount < 0
        ) {
          console.log(
            `⚠️ Skipped invalid plan: ${planCode}`
          );

          continue;
        }

        // IMPORTANT:
        // Match by BOTH plan_code and Peyflex network.
        //
        // This prevents:
        // MTN Gifting M1GBS
        // from being confused with
        // MTN Data Share M1GBS.

        const local =
          await DataPlan.findOne({
            plan_code: planCode,
            peyflexNetwork,
          });

        if (!local) {
          totalMissing++;

          console.log(
            `❌ NOT FOUND | ${planCode} | ${peyflexNetwork} | Peyflex ₦${peyflexAmount}`
          );

          continue;
        }

        const oldSellPrice =
          Number(local.sellPrice || 0);

        const oldCostPrice =
          Number(local.costPrice || 0);

        // ─────────────────────────────────────
        // ONLY UPDATE PROVIDER COST
        // ─────────────────────────────────────

        local.costPrice =
          peyflexAmount;

        // Make sure provider remains Peyflex.
        local.provider = "PEYFLEX";

        // DO NOT CHANGE:
        // local.sellPrice
        // local.tierPrices
        // local.title
        // local.isActive

        await local.save();

        totalUpdated++;

        const profit =
          oldSellPrice - peyflexAmount;

        console.log(
          `✅ ${planCode} | Sell ₦${oldSellPrice} | Old Cost ₦${oldCostPrice} | New Cost ₦${peyflexAmount} | Profit ₦${profit}`
        );
      }
    } catch (err) {
      console.error(
        `❌ ${peyflexNetwork} failed:`,
        err.response?.data ||
          err.message
      );
    }
  }

  console.log("\n================================");
  console.log("🎉 PEYFLEX COST SYNC COMPLETE");
  console.log("================================");

  console.log(
    `Plans fetched: ${totalFetched}`
  );

  console.log(
    `Provider costs updated: ${totalUpdated}`
  );

  console.log(
    `Plans not found: ${totalMissing}`
  );

  console.log(
    "\n🔒 Selling prices were NOT changed."
  );

  console.log(
    "🔒 Tier prices were NOT changed."
  );

  console.log(
    "🔒 No plans were created or deleted."
  );

  await mongoose.disconnect();

  console.log(
    "\n✅ MongoDB disconnected."
  );
}

run().catch(async (err) => {
  console.error(
    "\n❌ Sync failed:",
    err
  );

  try {
    await mongoose.disconnect();
  } catch (_) {}

  process.exit(1);
});