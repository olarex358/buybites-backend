const axios = require("axios");

function peyflexClient() {
  return axios.create({
    baseURL: process.env.PEYFLEX_BASE_URL,
    headers: {
      Authorization: `Token ${process.env.PEYFLEX_TOKEN}`,
      "Content-Type": "application/json"
    },
    timeout: 25000
  });
}

module.exports = { peyflexClient };
