const { getPeyflexBalance } = require("./providers/peyflex.provider");

function getFundingConfig() {
  const minimumBalance = Number(
    process.env.PEYFLEX_MIN_BALANCE || 2000
  );

  const targetBalance = Number(
    process.env.PEYFLEX_TARGET_BALANCE || 5000
  );

  if (
    !Number.isFinite(minimumBalance) ||
    !Number.isFinite(targetBalance) ||
    minimumBalance < 0 ||
    targetBalance <= minimumBalance
  ) {
    throw new Error(
      "Invalid Peyflex funding configuration"
    );
  }

  return {
    minimumBalance,
    targetBalance,
  };
}

async function getPeyflexFundingStatus() {
  const {
    minimumBalance,
    targetBalance,
  } = getFundingConfig();

  const result = await getPeyflexBalance();

  const currentBalance = Number(
    result?.data?.wallet_credit ??
    result?.wallet_credit ??
    result?.balance ??
    0
  );

  if (!Number.isFinite(currentBalance)) {
    throw new Error(
      "Unable to determine Peyflex wallet balance"
    );
  }

  const fundingRequired =
    currentBalance < minimumBalance
      ? Number(
          (targetBalance - currentBalance).toFixed(2)
        )
      : 0;

  return {
    currentBalance,
    minimumBalance,
    targetBalance,
    fundingRequired,
    needsFunding: currentBalance < minimumBalance,
    source: "PEYFLEX_LIVE",
  };
}

module.exports = {
  getPeyflexFundingStatus,
};