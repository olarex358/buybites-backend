const { peyflexClient } = require("../peyflex.service");
const { buyData: smeDataBuy } = require("./smedata.provider");

async function timed(provider, operation, fn) {
  const started = Date.now();
  try {
    const data = await fn();
    return {
      data,
      providerMeta: {
        provider,
        operation,
        latencyMs: Date.now() - started,
      },
    };
  } catch (error) {
    error.providerMeta = {
      provider,
      operation,
      latencyMs: Date.now() - started,
    };
    throw error;
  }
}

async function peyflexData({ network, mobile_number, plan_code, reference }) {
  return timed("PEYFLEX", "DATA", async () => {
    const api = peyflexClient();
    const response = await api.post("/api/data/purchase/", {
      network,
      mobile_number,
      plan_code,
      reference,
    });
    return response.data;
  });
}

async function smedataData({ network, planId, phone, reference }) {
  return timed("SMEDATA", "DATA", () =>
    smeDataBuy({ network, planId, phone, reference })
  );
}

module.exports = { peyflexData, smedataData };
