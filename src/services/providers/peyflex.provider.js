const axios = require("axios");

function pfClient() {
  return axios.create({
    baseURL: process.env.PEYFLEX_BASE_URL,
    headers: {
      Authorization: `Token ${process.env.PEYFLEX_TOKEN}`,
      "Content-Type": "application/json",
    },
    timeout: 30000,
  });
}

// ── AIRTIME ──────────────────────────────────────────────────
// POST /api/airtime/topup/
async function buyAirtime({ network, phone, amount, reference }) {
  const { data } = await pfClient().post("/api/airtime/topup/", {
    network,
    mobile_number: phone,
    amount,
    reference,
  });
  return data;
}

// ── ELECTRICITY ───────────────────────────────────────────────
// GET /api/electricity/verify/?meter_number=xxx&disco=IKEDC&meter_type=PREPAID
async function verifyElectricity({ disco, meterNumber, meterType }) {
  const { data } = await pfClient().get("/api/electricity/verify/", {
    params: {
      meter_number: meterNumber,
      disco:        disco,
      meter_type:   meterType,   // PREPAID or POSTPAID
    },
  });
  return data;
}

// POST /api/electricity/recharge/
async function buyElectricity({ disco, meterNumber, meterType, amount, phone, reference }) {
  const { data } = await pfClient().post("/api/electricity/recharge/", {
    disco,
    meter_number: meterNumber,
    meter_type:   meterType,
    amount,
    phone,
    reference,
  });
  return data;
}

// ── CABLE TV ──────────────────────────────────────────────────
// POST /api/cable/verify-iuc/
async function verifyCableIUC({ provider, smartcardNumber }) {
  const { data } = await pfClient().post("/api/cable/verify-iuc/", {
    provider,
    smartcard_number: smartcardNumber,
  });
  return data;
}

// POST /api/cable/recharge/
async function buyCable({ provider, smartcardNumber, planCode, phone, reference }) {
  const { data } = await pfClient().post("/api/cable/recharge/", {
    provider,
    smartcard_number: smartcardNumber,
    plan_code:        planCode,
    phone,
    reference,
  });
  return data;
}

module.exports = {
  buyAirtime,
  verifyElectricity,
  buyElectricity,
  verifyCableIUC,
  buyCable,
};