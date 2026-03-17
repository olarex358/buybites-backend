const axios = require("axios");

// ─────────────────────────────────────────────────────────────────────────────
//  SMEData.ng Provider
//  Base URL: https://smedata.ng/wp-json/api/v1/
//  Auth: Basic Auth token passed as ?token=xxx query param
//  All requests are GET-based
//
//  Add to your .env:
//    SMEDATA_TOKEN=your_token_here
//    SMEDATA_BASE_URL=https://smedata.ng/wp-json/api/v1
// ─────────────────────────────────────────────────────────────────────────────

const SMEDATA_BASE = process.env.SMEDATA_BASE_URL || "https://smedata.ng/wp-json/api/v1";
const SMEDATA_TOKEN = process.env.SMEDATA_TOKEN;

function smeClient() {
  return axios.create({
    baseURL: SMEDATA_BASE,
    timeout: 30000,
    headers: { "Content-Type": "application/json" },
  });
}

function authParams(extra = {}) {
  return { token: SMEDATA_TOKEN, ...extra };
}

// ── GET /data — fetch available data plans ────────────────────
async function getDataPlans({ network } = {}) {
  const { data } = await smeClient().get("/data", {
    params: authParams(network ? { network } : {}),
  });
  return data;
}

// ── GET /data — buy data plan ─────────────────────────────────
// SMEData uses GET for purchases too
async function buyData({ network, planId, phone, reference }) {
  if (!SMEDATA_TOKEN) {
    throw new Error("SMEDATA_TOKEN not set. Register at smedata.ng to get your API token.");
  }

  const { data } = await smeClient().get("/data", {
    params: authParams({
      network,
      plan_id:      planId,
      phone,
      request_id:   reference,  // unique ref to prevent duplicates
    }),
  });

  return data;
}

// ── GET /balance — check SMEData wallet balance ───────────────
async function getBalance() {
  const { data } = await smeClient().get("/balance", {
    params: authParams(),
  });
  return data;
}

module.exports = { getDataPlans, buyData, getBalance };