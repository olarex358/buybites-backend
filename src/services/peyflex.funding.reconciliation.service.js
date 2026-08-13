const ProviderFunding = require("../models/ProviderFunding");

const {
  queryPayout,
} = require("./korapay.transfer.service");

async function reconcilePeyflexFunding(reference) {
  if (!reference) {
    throw new Error("Funding reference is required");
  }

  const funding = await ProviderFunding.findOne({
    reference,
  });

  if (!funding) {
    throw new Error("Funding request not found");
  }

  if (!funding.korapayReference) {
    throw new Error(
      "Funding request does not have a Korapay reference"
    );
  }

  if (
    funding.status !== "PROCESSING" &&
    funding.status !== "APPROVED"
  ) {
    return {
      ok: true,
      message: `Funding request is already ${funding.status}`,
      status: funding.status,
      data: funding,
    };
  }

  let result;

  try {
    result = await queryPayout(
      funding.korapayReference
    );
  } catch (error) {
    const statusCode = error.response?.status;
    const providerData = error.response?.data;

    // Korapay says transaction does not exist.
    // DO NOT mark our funding request FAILED.
    if (
      statusCode === 404 &&
      providerData?.code === "AA026"
    ) {
      return {
        ok: false,
        message:
          "Korapay transaction was not found.",
        status: "NOT_FOUND",
        data: funding,
        korapay: providerData,
      };
    }

    throw error;
  }

  const payoutData =
    result?.data || result;

  const rawStatus = String(
    payoutData?.status ||
      payoutData?.transaction_status ||
      payoutData?.payment_status ||
      ""
  ).toUpperCase();

  // ---------------------------------------------------------
  // SUCCESS
  // ---------------------------------------------------------
  if (
    [
      "SUCCESS",
      "COMPLETED",
      "SUCCESSFUL",
    ].includes(rawStatus)
  ) {
    funding.status = "SUCCESS";
    funding.failureReason = "";
    funding.completedAt = new Date();

    await funding.save();

    return {
      ok: true,
      message:
        "Peyflex funding payout completed",
      status: "SUCCESS",
      data: funding,
      korapay: result,
    };
  }

  // ---------------------------------------------------------
  // FAILED
  // ---------------------------------------------------------
  if (
    [
      "FAILED",
      "FAILURE",
      "CANCELLED",
      "REVERSED",
    ].includes(rawStatus)
  ) {
    funding.status = "FAILED";

    funding.failureReason =
      payoutData?.failure_reason ||
      payoutData?.message ||
      payoutData?.reason ||
      `Korapay payout status: ${rawStatus}`;

    await funding.save();

    return {
      ok: false,
      message:
        "Peyflex funding payout failed",
      status: "FAILED",
      data: funding,
      korapay: result,
    };
  }

  // ---------------------------------------------------------
  // STILL PROCESSING / UNKNOWN
  // ---------------------------------------------------------
  funding.status = "PROCESSING";

  await funding.save();

  return {
    ok: true,
    message:
      "Peyflex funding payout is still processing",
    status: "PROCESSING",
    data: funding,
    korapay: result,
  };
}

module.exports = {
  reconcilePeyflexFunding,
};