const axios = require("axios");

function termiiClient() {
  const baseURL = process.env.TERMII_BASE_URL || "https://api.ng.termii.com";
  return axios.create({ baseURL, timeout: 15000 });
}

// WhatsApp OTP via Termii "Send WhatsApp Token"
// Endpoint: POST /api/sms/send
// channel: "whatsapp_otp"
function normalizeNigeriaPhone(phone) {
  const raw = String(phone || "").replace(/\D/g, "");
  if (!raw) return "";
  if (raw.startsWith("234")) return raw;
  if (raw.startsWith("0") && raw.length === 11) return `234${raw.slice(1)}`;
  if (raw.length === 10) return `234${raw}`;
  return raw;
}

function transactionSmsConfigured() {
  return Boolean(
    process.env.TERMII_API_KEY &&
    process.env.TERMII_TRANSACTION_SMS_ENABLED === "true"
  );
}

async function sendCriticalTransactionSms({ to, title, message }) {
  if (!transactionSmsConfigured()) {
    return { configured: false, sent: false };
  }

  const normalizedTo = normalizeNigeriaPhone(to);
  if (!normalizedTo) {
    return { configured: true, sent: false, reason: "invalid_phone" };
  }

  const from = process.env.TERMII_SMS_FROM || process.env.TERMII_WHATSAPP_FROM || "NEX";
  const api = termiiClient();

  const payload = {
    api_key: process.env.TERMII_API_KEY,
    to: normalizedTo,
    from,
    sms: `${title}\n${message}`,
    type: "plain",
    channel: process.env.TERMII_SMS_CHANNEL || "generic",
  };

  const response = await api.post("/api/sms/send", payload);

  return {
    configured: true,
    sent: true,
    response: response.data,
  };
}

async function sendWhatsappOtp({ to, otp }) {
  if (!process.env.TERMII_API_KEY) throw new Error("TERMII_API_KEY not set");

  const from = process.env.TERMII_WHATSAPP_FROM || "BuyBites";
  const api = termiiClient();

  const payload = {
    api_key: process.env.TERMII_API_KEY,
    to,              // "2348012345678"
    from,            // sender/device name
    sms: `Your OTP is ${otp}. Valid for 5 minutes.`,
    type: "plain",
    channel: process.env.TERMII_CHANNEL || "generic",
  };

  const r = await api.post("/api/sms/send", payload);
  return r.data;
}

module.exports = { sendWhatsappOtp, sendCriticalTransactionSms, transactionSmsConfigured, normalizeNigeriaPhone };
