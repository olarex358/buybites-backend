const { getProvider, listProviders } = require("./provider.registry");
const { recommendProvider, getProviderHealth } = require("./provider.health");

function parseProviderList(raw) {
  return String(raw || "")
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
}

function configuredOrder(service) {
  const svc = String(service || "").toUpperCase();
  const envKey = `NEX_${svc}_PROVIDERS`;
  return parseProviderList(process.env[envKey]);
}

/**
 * Health-aware provider recommendation.
 *
 * The allow-list is always explicit. This prevents NEX from accidentally
 * sending a product to a provider that does not understand its plan code.
 */
async function recommend({ service, allowedProviders }) {
  const configured = configuredOrder(service);
  const providers =
    allowedProviders?.length
      ? allowedProviders
      : configured.length
        ? configured
        : listProviders(service);

  const usable = providers.filter((provider) => !!getProvider(provider, service));

  const recommendation = await recommendProvider({
    service,
    providers: usable,
  });

  return recommendation
    ? {
        provider: recommendation.provider,
        score: recommendation.score,
        state: recommendation.state,
        confidence: recommendation.confidence,
        circuitOpen: recommendation.circuitOpen,
      }
    : null;
}

async function healthSnapshot({ service, providers }) {
  const names =
    providers?.length
      ? providers
      : configuredOrder(service).length
        ? configuredOrder(service)
        : listProviders(service);

  const usable = names.filter((provider) => !!getProvider(provider, service));

  return Promise.all(
    usable.map((provider) => getProviderHealth({ provider, service }))
  );
}

function adapter(provider, service) {
  return getProvider(provider, service);
}

module.exports = {
  recommend,
  healthSnapshot,
  adapter,
  configuredOrder,
  parseProviderList,
};
