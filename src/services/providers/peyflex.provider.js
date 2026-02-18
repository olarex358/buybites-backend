const axios = require("axios");

const PEYFLEX_BASE = process.env.PEYFLEX_BASE_URL;
const PEYFLEX_TOKEN = process.env.PEYFLEX_TOKEN;

function pfHeaders() {
  return {
    Authorization: `Bearer ${PEYFLEX_TOKEN}`,
    "Content-Type": "application/json",
  };
}

/**
 * NOTE:
 * Replace the endpoint paths below to match your Peyflex API spec
 * because different vendors name these endpoints differently.
 */
async function buyAirtime({ network, phone, amount, reference }) {
  const { data } = await axios.post(
    `${PEYFLEX_BASE}/vtu/airtime`,
    { network, phone, amount, reference },
    { headers: pfHeaders() }
  );
  return data;
}

async function verifyElectricity({ disco, meterNumber, meterType }) {
  const { data } = await axios.post(
    `${PEYFLEX_BASE}/vtu/electricity/verify`,
    { disco, meterNumber, meterType },
    { headers: pfHeaders() }
  );
  return data;
}

async function buyElectricity({ disco, meterNumber, meterType, amount, phone, reference }) {
  const { data } = await axios.post(
    `${PEYFLEX_BASE}/vtu/electricity`,
    { disco, meterNumber, meterType, amount, phone, reference },
    { headers: pfHeaders() }
  );
  return data;
}

module.exports = {
  buyAirtime,
  verifyElectricity,
  buyElectricity,
};
