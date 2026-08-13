const TransactionEvent = require("../models/TransactionEvent");

async function recordTransactionEvent(
  tx,
  {
    status = tx?.status || "PROCESSING",
    processingStage = tx?.processingStage || "",
    message = tx?.statusMessage || "",
    source = "SYSTEM",
    providerRef = tx?.providerRef || "",
    meta = {},
  } = {}
) {
  if (!tx?._id || !tx?.userId) return null;

  try {
    return await TransactionEvent.create({
      transactionId: tx._id,
      userId: tx.userId,
      status,
      processingStage,
      message: String(message || "").slice(0, 500),
      source,
      providerRef: providerRef ? String(providerRef) : "",
      meta,
    });
  } catch (error) {
    // Event history is observability data. It must never break a financial
    // transaction lifecycle.
    console.error("[tx.events] record failed:", error.message);
    return null;
  }
}

module.exports = { recordTransactionEvent };
