const { getProvider } = require("./provider.registry");

/**
 * Provider adapters may optionally expose:
 *   query({ reference, tx }) => {
 *     status: "SUCCESS" | "FAILED" | "PROCESSING",
 *     providerRef,
 *     token,
 *     message,
 *     providerMeta
 *   }
 *
 * No provider is considered queryable unless the adapter explicitly exposes
 * this method. This prevents NEX from guessing undocumented endpoints.
 */

function normalizeStatus(value) {
  const s = String(value || "").toUpperCase();
  if (["SUCCESS", "COMPLETED", "DELIVERED"].includes(s)) return "SUCCESS";
  if (["FAILED", "FAILURE", "CANCELLED", "REJECTED"].includes(s)) return "FAILED";
  return "PROCESSING";
}

async function requeryTransaction(tx) {
  const provider = String(tx.provider || "").toUpperCase();
  const adapter = getProvider(provider, tx.type);

  if (!adapter || typeof adapter.query !== "function") {
    return {
      supported: false,
      status: "PROCESSING",
      message: "This provider does not expose a configured status-requery method.",
    };
  }

  const started = Date.now();
  const result = await adapter.query({
    reference: tx.reference,
    tx,
  });

  return {
    supported: true,
    status: normalizeStatus(result?.status),
    providerRef: result?.providerRef || result?.reference || "",
    token: result?.token || "",
    message: result?.message || "",
    providerMeta: {
      ...(result?.providerMeta || {}),
      provider,
      operation: "STATUS_REQUERY",
      latencyMs: result?.providerMeta?.latencyMs ?? (Date.now() - started),
    },
  };
}

module.exports = {
  requeryTransaction,
};
