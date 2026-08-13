const { listProviders } = require("./provider.registry");
const { recommendProvider } = require("./provider.health");

function envProviders(service) {
  const key = `NEX_${String(service || "").toUpperCase()}_PROVIDERS`;
  return String(process.env[key] || "")
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * Recommend a provider before a transaction is sent.
 *
 * IMPORTANT: this does not switch an existing transaction after wallet debit.
 * Data plans may have different provider-specific product codes, so the selected
 * plan's provider remains authoritative unless the plan explicitly supports
 * another provider mapping.
 */
async function recommendForService(service, configured = []) {
  const serviceName = String(service || "").toUpperCase();
  const providers =
    configured.length
      ? configured
      : envProviders(serviceName).length
        ? envProviders(serviceName)
        : listProviders(serviceName);

  return recommendProvider({
    service: serviceName,
    providers,
  });
}

async function getRoutingSnapshot(service) {
  const providers = envProviders(service);
  const pool = providers.length ? providers : listProviders(service);

  const recommendation = await recommendForService(service, pool);

  return {
    service: String(service || "").toUpperCase(),
    providers: pool,
    recommended: recommendation?.provider || null,
    recommendation: recommendation || null,
    automaticFailover: false,
    reason:
      "NEX does not silently switch a provider after wallet debit because provider product codes and transaction semantics may differ.",
  };
}

module.exports = {
  recommendForService,
  getRoutingSnapshot,
};
