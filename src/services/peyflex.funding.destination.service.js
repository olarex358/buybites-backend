const {
  resolveBankAccount,
} = require("./korapay.transfer.service");

async function verifyPeyflexFundingDestination() {
  const bank = String(
    process.env.PEYFLEX_FUNDING_BANK_CODE || ""
  ).trim();

  const account = String(
    process.env.PEYFLEX_FUNDING_ACCOUNT || ""
  ).trim();

  const expectedBank = String(
    process.env.PEYFLEX_FUNDING_BANK_NAME || ""
  ).trim().toUpperCase();

  const expectedName = String(
    process.env.PEYFLEX_FUNDING_ACCOUNT_NAME || ""
  ).trim().toUpperCase();

  if (!bank || !account) {
    throw new Error(
      "Peyflex funding destination is not configured"
    );
  }

  const result = await resolveBankAccount({
    bank,
    account,
  });

  const data = result?.data;

  if (!data) {
    throw new Error(
      "Korapay did not return funding destination details"
    );
  }

  const actualBank =
    String(data.bank_name || "").trim().toUpperCase();

  const actualName =
    String(data.account_name || "").trim().toUpperCase();

  if (actualBank !== expectedBank) {
    throw new Error(
      `Funding bank mismatch. Expected ${expectedBank}, received ${actualBank}`
    );
  }

  if (
    expectedName &&
    !actualName.includes(expectedName.split("(")[0].trim())
  ) {
    throw new Error(
      `Funding account name mismatch. Expected ${expectedName}, received ${actualName}`
    );
  }

  return {
    verified: true,
    bankCode: data.bank_code,
    bankName: data.bank_name,
    accountNumber: data.account_number,
    accountName: data.account_name,
  };
}

module.exports = {
  verifyPeyflexFundingDestination,
};