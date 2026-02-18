const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const { api } = require("../controllers/tx.controller"); // if you have a tx controller helper

router.get("/providers", protect, (req, res) => {
  res.json({ ok: true, providers: ["MTN", "GLO", "AIRTEL", "9MOBILE"] });
});

router.post("/buy", protect, async (req, res, next) => {
  try {
    req.body = {
      type: "AIRTIME",
      meta: req.body, // { network, mobile_number, amount }
    };
    return api.createTx(req, res, next); // reuse your tx/create logic
  } catch (e) {
    next(e);
  }
});

module.exports = router;
