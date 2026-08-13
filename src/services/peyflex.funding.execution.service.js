const ProviderFunding = require("../models/ProviderFunding");

const {
  getKorapayBalance,
  createPayout,
} = require("./korapay.transfer.service");

const {
  verifyPeyflexFundingDestination,
} = require("./peyflex.funding.destination.service");

function generateKorapayReference(fundingReference) {
  return `${fundingReference}-KP`;
}

async function executePeyflexFunding(reference) {
  if (!reference) {
    throw new Error("Funding reference is required");
  }

  // ---------------------------------------------------------
  // 1. Find funding request
  // ---------------------------------------------------------
  const funding = await ProviderFunding.findOne({
    reference,
  });

  if (!funding) {
    throw new Error("Funding request not found");
  }

  // ---------------------------------------------------------
  // 2. Only APPROVED requests can be executed
  // ---------------------------------------------------------
  if (funding.status !== "APPROVED") {
    throw new Error(
      `Funding request cannot be executed from status ${funding.status}`
    );
  }

  // ---------------------------------------------------------
  // 3. Prevent duplicate payout
  // ---------------------------------------------------------
  if (funding.korapayReference) {
    throw new Error(
      `Funding request already has a Korapay reference: ${funding.korapayReference}`
    );
  }

  // ---------------------------------------------------------
  // 4. Check Korapay balance BEFORE doing anything
  // ---------------------------------------------------------
  const balanceResponse = await getKorapayBalance();

  const availableBalance = Number(
    balanceResponse?.data?.NGN?.available_balance || 0
  );

  const requiredAmount = Number(funding.amount);

  if (
    !Number.isFinite(availableBalance) ||
    availableBalance < requiredAmount
  ) {
    throw new Error(
      `Insufficient Korapay balance. Available ₦${availableBalance}, required ₦${requiredAmount}`
    );
  }

// ---------------------------------------------------------
// 5. Resolve payout destination
// ---------------------------------------------------------
let destination;

const korapayMode =
  String(process.env.KORAPAY_MODE || "live").toLowerCase();

if (korapayMode === "test") {
  // Sandbox-only destination.
  // Never used in live mode.
  destination = {
    verified: true,
    accountNumber:
      funding.destinationAccount || "0000000000",
    bankCode:
      funding.destinationBankCode || "033",
    bankName:
      funding.destinationBankName || "KORA SANDBOX",
    accountName:
      funding.destinationAccountName || "NEX Sandbox Test",
  };
} else {
  // LIVE: always verify the real Peyflex destination.
  destination =
    await verifyPeyflexFundingDestination();

  if (!destination?.verified) {
    throw new Error(
      "Peyflex funding destination could not be verified"
    );
  }
}

// ---------------------------------------------------------
// 6. Save resolved destination
// ---------------------------------------------------------
funding.destinationAccount =
  destination.accountNumber;

funding.destinationBankCode =
  destination.bankCode;

funding.destinationBankName =
  destination.bankName;

funding.destinationAccountName =
  destination.accountName;
  // ---------------------------------------------------------
  // 7. Generate unique Korapay reference
  // ---------------------------------------------------------
  const korapayReference =
    generateKorapayReference(reference);

  funding.korapayReference =
    korapayReference;

  funding.status = "PROCESSING";

  funding.failureReason = "";

  await funding.save();

  // ---------------------------------------------------------
  // 8. Initiate Korapay payout
  // ---------------------------------------------------------
  try {
    const payout = await createPayout({
      reference: korapayReference,

      amount: requiredAmount,

      bankCode:
        destination.bankCode,

      accountNumber:
        destination.accountNumber,

      narration:
        funding.narration ||
        "NEX Peyflex wallet funding",

      customerName:
        destination.accountName,

      customerEmail:
        process.env.PEYFLEX_FUNDING_EMAIL ||
        "support@nex.com",

      notificationUrl:
        process.env.KORAPAY_WEBHOOK_URL || undefined,
    });

    return {
      ok: true,

      message:
        "Peyflex funding payout initiated",

      funding: funding.toObject(),

      korapay: payout,
    };
  } catch (error) {
    // -------------------------------------------------------
    // 9. If payout request itself fails, mark FAILED
    // -------------------------------------------------------
    funding.status = "FAILED";

    funding.failureReason =
      error.response?.data?.message ||
      error.response?.data?.error ||
      error.message ||
      "Korapay payout failed";

    await funding.save();

    throw error;
  }
}

module.exports = {
  executePeyflexFunding,
};