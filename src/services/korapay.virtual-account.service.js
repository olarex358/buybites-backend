const axios = require("axios");

const KORA_BASE = "https://api.korapay.com/merchant/api/v1";

function isEnabled() {
  return String(process.env.KORAPAY_VIRTUAL_ACCOUNT_ENABLED || "").toLowerCase() === "true";
}

async function koraRequest(method, path, data = null) {
  const secret =
  String(process.env.KORAPAY_MODE || "live").toLowerCase() === "sandbox"
    ? process.env.KORAPAY_TEST_SECRET_KEY
    : process.env.KORAPAY_SECRET_KEY;
  if (!secret) throw new Error("Korapay secret key is not configured");

  const response = await axios({
    method,
    url: `${KORA_BASE}${path}`,
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    data,
    timeout: 15000,
  });

  return response.data;
}

async function createKorapayVirtualAccount({
  accountName,
  accountReference,
  email,
  bvn,
  nin,
  bankCode =
  process.env.KORAPAY_VIRTUAL_ACCOUNT_BANK_CODE ||
  (String(process.env.KORAPAY_MODE || "live").toLowerCase() === "sandbox"
    ? "000"
    : "070"),
}) {
  if (!isEnabled()) {
    const error = new Error("Virtual accounts are not enabled for this NEX environment.");
    error.status = 503;
    throw error;
  }

  if (!bvn || !/^\d{11}$/.test(String(bvn))) {
    const error = new Error("A valid 11-digit BVN is required by the virtual-account provider.");
    error.status = 400;
    throw error;
  }

  const response = await koraRequest("POST", "/virtual-bank-account", {
    account_name: accountName,
    account_reference: accountReference,
    permanent: true,
    bank_code: bankCode,
    customer: {
      name: accountName,
      ...(email ? { email } : {}),
    },
    kyc: {
      bvn: String(bvn),
      ...(nin ? { nin: String(nin) } : {}),
    },
  });

  if (!response?.status || !response?.data?.account_number) {
    const error = new Error(
      response?.message || "Korapay did not return a virtual account."
    );
    error.status = 502;
    throw error;
  }

  return response.data;
}

async function queryKorapayVirtualAccount(accountReference) {
  return koraRequest(
    "GET",
    `/virtual-bank-account/${encodeURIComponent(accountReference)}`
  );
}

module.exports = {
  isEnabled,
  createKorapayVirtualAccount,
  queryKorapayVirtualAccount,
};
