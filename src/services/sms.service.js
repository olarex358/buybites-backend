const axios = require("axios");

function termiiClient() {
  const baseURL = process.env.TERMII_BASE_URL || "https://api.ng.termii.com";
  return axios.create({ baseURL, timeout: 15000 });
}

// WhatsApp OTP via Termii "Send WhatsApp Token"
// Endpoint: POST /api/sms/send
// channel: "whatsapp_otp"
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

module.exports = { sendWhatsappOtp };
