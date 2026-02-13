const axios = require("axios");

function cleanBaseUrl(u) {
  return String(u || "").replace(/\/+$/, "");
}

async function sendSms({ to, message }) {
  const apiKey = process.env.TERMII_API_KEY;
  const baseUrl = cleanBaseUrl(process.env.TERMII_BASE_URL || "https://api.ng.termii.com");
  const from = process.env.TERMII_SENDER_ID || "BuyBites";
  const channel = process.env.TERMII_CHANNEL || "dnd"; // OTP should be DND
  const type = process.env.TERMII_TYPE || "plain";

  // Dev fallback (no key yet)
  if (!apiKey) {
    console.log("📩 [DEV SMS LOG]", { to, message });
    return { ok: true, provider: "dev", message_id: "dev" };
  }

  const url = `${baseUrl}/api/sms/send`;

  const payload = {
    api_key: apiKey,
    to,
    from,
    sms: message,
    type,
    channel,
  };

  const { data } = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 15000,
  });

  return { ok: true, provider: "termii", data };
}

module.exports = { sendSms };
