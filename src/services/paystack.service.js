const axios = require("axios");

function paystackClient() {
  return axios.create({
    baseURL: "https://api.paystack.co",
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json"
    },
    timeout: 20000
  });
}

module.exports = { paystackClient };
