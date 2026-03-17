const router = require("express").Router();

// ✅ VERY IMPORTANT (for SME validation)
router.get("/smedata", (req, res) => {
  return res.sendStatus(200);
});

// ✅ MAIN WEBHOOK
router.post("/smedata", (req, res) => {
  // ⚡ Respond FIRST (VERY IMPORTANT)
  res.sendStatus(200);

  // ⚡ Then process (async, no delay to SME)
  setImmediate(async () => {
    try {
      console.log("SME Webhook:", req.body);

      const { code, message, data } = req.body;

      if (code === "success") {
        console.log("Data delivered:", data);
      } else {
        console.log("Failed:", message);
      }

    } catch (err) {
      console.error("Webhook error:", err);
    }
  });
});

module.exports = router;