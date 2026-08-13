const express = require("express");
const router = express.Router();

const { auth } = require("../middleware/auth");
const {
  getLoyaltySnapshot,
  getLoyaltyHistory,
  LEVELS,
  AGENT_RANKS,
  NAIRA_PER_POINT,
} = require("../services/loyalty.service");

router.get("/me", auth, async (req, res) => {
  try {
    const loyalty = await getLoyaltySnapshot(req.user.sub);
    if (!loyalty) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    return res.json({
      ok: true,
      loyalty,
      levels: LEVELS,
      agentRanks: AGENT_RANKS,
      pointsRate: NAIRA_PER_POINT,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/history", auth, async (req, res) => {
  try {
    const items = await getLoyaltyHistory(req.user.sub, req.query.limit);
    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
