const ProviderFunding = require("../models/ProviderFunding");

const {
  getPeyflexFundingStatus,
} = require("../services/peyflex.funding.service");

let running = false;

async function checkPeyflexFunding() {
  if (running) {
    console.log("[peyflex-funding-worker] Previous check still running.");
    return;
  }

  running = true;

  try {
    const status = await getPeyflexFundingStatus();

    console.log(
      "[peyflex-funding-worker]",
      JSON.stringify(status)
    );

    if (!status.needsFunding) {
      return;
    }

    // -------------------------------------------------------
    // Prevent duplicate pending/processing requests
    // -------------------------------------------------------
    const existing = await ProviderFunding.findOne({
      provider: "PEYFLEX",
      fundingProvider: "KORAPAY",
      status: {
        $in: ["PENDING", "APPROVED", "PROCESSING"],
      },
    }).sort({ createdAt: -1 });

    if (existing) {
      console.log(
        `[peyflex-funding-worker] Existing request ${existing.reference} is ${existing.status}.`
      );

      return;
    }

    // -------------------------------------------------------
    // Create a new funding request
    // -------------------------------------------------------
    const reference =
      `NEX-AUTO-PF-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)
        .toUpperCase()}`;

    const request =
      await ProviderFunding.create({
        reference,

        provider: "PEYFLEX",

        fundingProvider: "KORAPAY",

        amount: Number(status.fundingRequired),

        peyflexBalanceBefore:
          Number(status.currentBalance),

        targetBalance:
          Number(status.targetBalance),

        status: "PENDING",

        narration:
          "NEX automatic Peyflex wallet funding",

        korapayReference: "",

        destinationAccount:
          process.env.PEYFLEX_FUNDING_ACCOUNT || "",

        destinationBankCode:
          process.env.PEYFLEX_FUNDING_BANK_CODE || "",

        destinationBankName:
          process.env.PEYFLEX_FUNDING_BANK_NAME || "",

        destinationAccountName:
          process.env.PEYFLEX_FUNDING_ACCOUNT_NAME || "",

        failureReason: "",
      });

    console.log(
      "[peyflex-funding-worker] Funding request created:",
      request.reference
    );

    console.log(
      `[peyflex-funding-worker] Amount: ₦${request.amount}`
    );

    console.log(
      "[peyflex-funding-worker] Awaiting admin approval."
    );
  } catch (error) {
    console.error(
      "[peyflex-funding-worker] Error:",
      error.response?.data ||
        error.message ||
        error
    );
  } finally {
    running = false;
  }
}

function startPeyflexFundingWorker() {
  const intervalMinutes = Number(
    process.env.PEYFLEX_FUNDING_CHECK_MINUTES || 10
  );

  const intervalMs =
    Math.max(intervalMinutes, 1) * 60 * 1000;

  console.log(
    `💰 Peyflex funding worker started. Checking every ${intervalMinutes} minute(s).`
  );

  // Initial check
  checkPeyflexFunding();

  // Repeated checks
  setInterval(
    checkPeyflexFunding,
    intervalMs
  );
}

module.exports = {
  checkPeyflexFunding,
  startPeyflexFundingWorker,
};