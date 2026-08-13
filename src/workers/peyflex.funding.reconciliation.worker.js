const ProviderFunding = require("../models/ProviderFunding");

const {
  queryPayout,
} = require("../services/korapay.transfer.service");

const {
  getPeyflexBalance,
} = require("../services/providers/peyflex.provider");

const INTERVAL_MS = 30000;
const BATCH_SIZE = 10;

async function reconcilePeyflexFunding(funding) {
  if (!funding.korapayReference) {
    return;
  }

  try {
    const result = await queryPayout(
      funding.korapayReference
    );

    const status =
      String(result?.data?.status || "").toLowerCase();

    if (status === "processing") {
      console.log(
        `[peyflex-funding-reconciliation] ${funding.reference} still processing`
      );

      return;
    }

    if (status === "failed") {
      funding.status = "FAILED";

      funding.failureReason =
        result?.data?.message ||
        result?.message ||
        "Korapay payout failed";

      await funding.save();

      console.log(
        `[peyflex-funding-reconciliation] ${funding.reference} FAILED`
      );

      return;
    }

    if (status !== "success") {
      console.log(
        `[peyflex-funding-reconciliation] ${funding.reference} unknown Korapay status: ${status}`
      );

      return;
    }

    // Korapay says SUCCESS.
    // Before closing the funding cycle, verify Peyflex balance.
    const peyflex = await getPeyflexBalance();

    const currentBalance = Number(
      peyflex?.balance ?? peyflex?.data?.balance ?? 0
    );

    const expectedMinimum =
      Number(funding.peyflexBalanceBefore || 0) +
      Number(funding.amount || 0);

    if (
      !Number.isFinite(currentBalance) ||
      currentBalance < expectedMinimum
    ) {
      console.log(
        `[peyflex-funding-reconciliation] ${funding.reference} Korapay SUCCESS but Peyflex balance not yet confirmed. Current: ₦${currentBalance}, expected at least: ₦${expectedMinimum}`
      );

      return;
    }

    funding.status = "SUCCESS";
    funding.completedAt = new Date();
    funding.failureReason = "";

    await funding.save();

    console.log(
      `[peyflex-funding-reconciliation] ${funding.reference} SUCCESS. Peyflex balance confirmed at ₦${currentBalance}`
    );
  } catch (error) {
    console.error(
      `[peyflex-funding-reconciliation] ${funding.reference}:`,
      error.response?.data ||
        error.message
    );
  }
}

async function checkPeyflexFundingReconciliation() {
  const fundingRequests =
    await ProviderFunding.find({
      status: "PROCESSING",
      korapayReference: {
        $exists: true,
        $ne: "",
      },
    })
      .sort({ updatedAt: 1 })
      .limit(BATCH_SIZE);

  for (const funding of fundingRequests) {
    await reconcilePeyflexFunding(funding);
  }
}

function startPeyflexFundingReconciliationWorker() {
  const run = async () => {
    try {
      await checkPeyflexFundingReconciliation();
    } catch (error) {
      console.error(
        "[peyflex-funding-reconciliation] worker error:",
        error.message
      );
    }
  };

  run();

  return setInterval(
    run,
    INTERVAL_MS
  );
}

module.exports = {
  reconcilePeyflexFunding,
  checkPeyflexFundingReconciliation,
  startPeyflexFundingReconciliationWorker,
};