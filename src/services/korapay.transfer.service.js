const axios = require("axios");

const BASE_URL =
  "https://api.korapay.com/merchant/api/v1";

function secret() {
  const mode =
    String(process.env.KORAPAY_MODE || "live")
      .toLowerCase();

  const key =
    mode === "test"
      ? process.env.KORAPAY_TEST_SECRET_KEY
      : process.env.KORAPAY_SECRET_KEY;

  if (!key) {
    throw new Error(
      `Korapay ${mode} secret key is not configured`
    );
  }

  return key;
}
async function request(method, path, data) {
  const response = await axios({
    method,
    url: `${BASE_URL}${path}`,
    headers: {
      Authorization: `Bearer ${secret()}`,
      "Content-Type": "application/json",
    },
    data,
    timeout: 15000,
  });
  return response.data;
}

async function listBanks(countryCode = "NG") {
  return request("GET", `/misc/banks?countryCode=${encodeURIComponent(countryCode)}`);
}

async function resolveBankAccount({ bank, account }) {
  return request("POST", "/misc/banks/resolve", {
    bank: String(bank),
    account: String(account),
    currency: "NGN",
  });
}

async function createPayout({
  reference,
  amount,
  bankCode,
  accountNumber,
  narration,
  customerName,
  customerEmail,
  notificationUrl,
}) {
  return request("POST", "/transactions/disburse", {
    reference,
    destination: {
      type: "bank_account",
      amount: Number(amount),
      currency: "NGN",
      narration: narration || "NEX transfer",
      bank_account: {
        bank: String(bankCode),
        account: String(accountNumber),
      },
      customer: {
        name: customerName,
        email: customerEmail,
      },
    },
    metadata: {
      source: "NEX",
      purpose: "WALLET_TRANSFER",
    },
    notification_url: notificationUrl,
  });
}

async function queryPayout(reference) {
  return request("GET", `/transactions/${encodeURIComponent(reference)}`);
}
async function getKorapayBalance() {
  return request("GET", "/balances");
}

module.exports = {
  listBanks,
  resolveBankAccount,
  createPayout,
  queryPayout,
  getKorapayBalance,
};