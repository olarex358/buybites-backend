const {
  buyAirtime,
  verifyElectricity,
  buyElectricity,
  verifyCableIUC,
  buyCable,
} = require("./peyflex.provider");

async function timed(name, fn) {
  const started = Date.now();
  try {
    const data = await fn();
    return {
      data,
      providerMeta: {
        provider: "PEYFLEX",
        operation: name,
        latencyMs: Date.now() - started,
      },
    };
  } catch (error) {
    error.providerMeta = {
      provider: "PEYFLEX",
      operation: name,
      latencyMs: Date.now() - started,
    };
    throw error;
  }
}

const peyflexAdapter = {
  async airtime(payload) {
    return timed("AIRTIME", () => buyAirtime(payload));
  },

  async electricityVerify(payload) {
    return timed("ELECTRICITY_VERIFY", () => verifyElectricity(payload));
  },

  async electricity(payload) {
    return timed("ELECTRICITY", () => buyElectricity(payload));
  },

  async cableVerify(payload) {
    return timed("CABLE_VERIFY", () => verifyCableIUC(payload));
  },

  async cable(payload) {
    return timed("CABLE", () => buyCable(payload));
  },
};

module.exports = { peyflexAdapter };
