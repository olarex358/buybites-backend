/**
 * NEX Provider Registry
 *
 * Provider adapters are registered explicitly by capability.
 * No provider is considered live merely because it appears in the catalog.
 */

const registry = new Map();

function key(provider, service) {
  return `${String(provider).toUpperCase()}:${String(service).toUpperCase()}`;
}

function registerProvider({ provider, service, adapter, enabled = true }) {
  if (!provider || !service || !adapter) {
    throw new Error("provider, service and adapter are required");
  }
  registry.set(key(provider, service), {
    provider: String(provider).toUpperCase(),
    service: String(service).toUpperCase(),
    adapter,
    enabled: Boolean(enabled),
  });
}

function getProvider(provider, service) {
  const entry = registry.get(key(provider, service));
  if (!entry || !entry.enabled) return null;
  return entry.adapter;
}

function capabilities() {
  return [...registry.values()].map((item) => ({
    provider: item.provider,
    service: item.service,
    enabled: item.enabled,
  }));
}

function listProviders(service) {
  const target = String(service || "").toUpperCase();
  return [...registry.values()]
    .filter((item) => item.enabled && (!target || item.service === target))
    .map((item) => item.provider);
}

module.exports = {
  registerProvider,
  getProvider,
  capabilities,
  listProviders,
};
