const router = require("express").Router();
const { auth } = require("../middleware/auth");
const { peyflexClient } = require("../services/peyflex.service");

router.get("/networks", auth, async (req, res, next) => {
  try {
    const api = peyflexClient();
    const r = await api.get("/api/data/networks/");
    res.json(r.data);
  } catch (e) { next(e); }
});

router.get("/plans", auth, async (req, res, next) => {
  try {
    const { network } = req.query;
    const api = peyflexClient();
    const r = await api.get(`/api/data/plans/?network=${encodeURIComponent(network || "")}`);
    res.json(r.data);
  } catch (e) { next(e); }
});

module.exports = router;
