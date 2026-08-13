const { registerProvider } = require("./provider.registry");
const { peyflexAdapter } = require("./providers/peyflex.adapter");
const { peyflexData, smedataData } = require("./providers/data.adapter");

function registerConfiguredProviders() {
  const enabled = Boolean(process.env.PEYFLEX_BASE_URL && process.env.PEYFLEX_TOKEN);

  registerProvider({
    provider: "PEYFLEX",
    service: "DATA",
    adapter: { data: peyflexData },
    enabled,
  });

  registerProvider({
    provider: "SMEDATA",
    service: "DATA",
    adapter: { data: smedataData },
    enabled: Boolean(process.env.SMEDATA_API_KEY || process.env.SMEDATA_TOKEN),
  });

  for (const service of ["AIRTIME", "ELECTRICITY", "CABLE"]) {
    registerProvider({
      provider: "PEYFLEX",
      service,
      adapter: peyflexAdapter,
      enabled,
    });
  }
}

module.exports = { registerConfiguredProviders };
