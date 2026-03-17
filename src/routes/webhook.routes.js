const router = require("express").Router();

// ✅ VALIDATION ROUTE (VERY IMPORTANT)
router.get("/smedata", (req, res) => {
  res.status(200).send("OK");
});

// ✅ MAIN WEBHOOK
router.post("/smedata", (req, res) => {
  // ⚡ ALWAYS RESPOND IMMEDIATELY
  res.status(200).send("OK");

  // ⚡ HANDLE LOGIC AFTER RESPONSE
  setImmediate(() => {
    try {
      console.log("SME WEBHOOK:", req.body);

      const { code, message, data } = req.body;

      if (code === "success") {
        console.log("SUCCESS:", data);
      } else {
        console.log("FAILED:", message);
      }

    } catch (err) {
      console.error("Webhook error:", err);
    }
  });
});

module.exports = router;