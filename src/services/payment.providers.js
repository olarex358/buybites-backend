const axios = require("axios");

function korapayClient() {
  if (!process.env.KORAPAY_SECRET_KEY) {
    throw new Error("Korapay secret key is not configured");
  }
  return axios.create({
    baseURL: "https://api.korapay.com/merchant/api/v1",
    headers: {
      Authorization: `Bearer ${process.env.KORAPAY_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });
}

function paystackClient() {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    throw new Error("Paystack secret key is not configured");
  }
  return axios.create({
    baseURL: "https://api.paystack.co",
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });
}

async function initializeCheckout({
  provider = "KORAPAY",
  reference,
  amount,
  customer,
  notificationUrl,
  redirectUrl,
  metadata = {},
}) {
  const p = String(provider).toUpperCase();

  if (p === "KORAPAY") {
    const { data } = await korapayClient().post("/charges/initialize", {
      reference,
      amount,
      currency: "NGN",
      narration: `NEX wallet funding - ${customer.phone || customer.email || reference}`,
      notification_url: notificationUrl,
      redirect_url: redirectUrl,
      customer: {
        name: customer.name,
        email: customer.email,
      },
      channels: ["card", "bank_transfer"],
      metadata,
    });

    return {
      provider: p,
      checkoutUrl: data?.data?.checkout_url || "",
      providerReference: data?.data?.reference || reference,
      raw: data,
    };
  }

  if (p === "PAYSTACK") {
    const { data } = await paystackClient().post("/transaction/initialize", {
      email: customer.email,
      amount: Math.round(Number(amount) * 100),
      reference,
      callback_url: redirectUrl,
      metadata,
      channels: ["card", "bank_transfer"],
    });

    return {
      provider: p,
      checkoutUrl: data?.data?.authorization_url || "",
      providerReference: data?.data?.reference || reference,
      raw: data,
    };
  }

  throw new Error(`Unsupported funding provider: ${p}`);
}

async function verifyCheckout(provider, reference) {
  const p = String(provider || "").toUpperCase();

  if (p === "KORAPAY") {
    const { data } = await korapayClient().get(`/charges/${encodeURIComponent(reference)}`);
    return {
      provider: p,
      status: String(data?.data?.status || "").toUpperCase(),
      amountPaid: Number(data?.data?.amount_paid || data?.data?.amount || 0),
      providerReference: data?.data?.reference || reference,
      raw: data,
    };
  }

  if (p === "PAYSTACK") {
    const { data } = await paystackClient().get(`/transaction/verify/${encodeURIComponent(reference)}`);
    return {
      provider: p,
      status: String(data?.data?.status || "").toUpperCase(),
      amountPaid: Number(data?.data?.amount || 0) / 100,
      providerReference: data?.data?.reference || reference,
      raw: data,
    };
  }

  throw new Error(`Unsupported funding provider: ${p}`);
}

module.exports = {
  initializeCheckout,
  verifyCheckout,
};
