const router    = require("express").Router();
const { z }     = require("zod");
const DataPlan  = require("../models/DataPlan");
const { peyflexClient } = require("../services/peyflex.service");

function isAdmin(req) {
  const key = req.headers["x-admin-key"];
  return key && process.env.ADMIN_KEY && key === process.env.ADMIN_KEY;
}

// Exact identifiers from Peyflex /api/data/networks/
const PEYFLEX_NETWORKS = [
  { identifier: "mtn_gifting_data", displayNetwork: "MTN" },
  { identifier: "mtn_data_share",   displayNetwork: "MTN" },
  { identifier: "glo_data",         displayNetwork: "GLO" },
  { identifier: "airtel_data",      displayNetwork: "AIRTEL" },
  { identifier: "9mobile_data",     displayNetwork: "9MOBILE" },
  { identifier: "9mobile_gifting",  displayNetwork: "9MOBILE" },
];

// GET /api/plans/:network  — frontend uses MTN | GLO | AIRTEL | 9MOBILE
router.get("/:network", async (req, res) => {
  try {
    const network = String(req.params.network || "").toUpperCase().trim();
    const plans = await DataPlan.find({ network, isActive: true }).sort({ sellPrice: 1 }).lean();
    return res.json({ ok: true, plans });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/plans/sync  — admin only, pulls all plans from Peyflex
router.post("/sync", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "Admin only" });

  const api = peyflexClient();
  const results = [];
  let totalSynced = 0;

  for (const { identifier, displayNetwork } of PEYFLEX_NETWORKS) {
    try {
      const r = await api.get(`/api/data/plans/?network=${encodeURIComponent(identifier)}`);
      const raw = r.data;

      const list = Array.isArray(raw)         ? raw
        : Array.isArray(raw?.results)         ? raw.results
        : Array.isArray(raw?.plans)           ? raw.plans
        : Array.isArray(raw?.data)            ? raw.data
        : [];

      let synced = 0;
      for (const item of list) {
        const plan_code = String(item.plan_code || item.code || item.id || "").trim();
        const title     = String(item.name || item.title || item.description || plan_code).trim();
        const sellPrice = Number(item.price || item.amount || item.selling_price || item.sellPrice || 0);
        const costPrice = Number(item.cost_price || item.cost || item.costPrice || 0);

        if (!plan_code || !sellPrice) continue;

        await DataPlan.findOneAndUpdate(
          { network: displayNetwork, plan_code },
          { network: displayNetwork, plan_code, title, sellPrice, costPrice, isActive: true },
          { upsert: true, new: true }
        );
        synced++;
      }

      results.push({ identifier, network: displayNetwork, synced });
      totalSynced += synced;
    } catch (e) {
      results.push({ identifier, network: displayNetwork, synced: 0, error: e?.response?.data || e.message });
    }
  }

  return res.json({ ok: true, totalSynced, results });
});

// POST /api/plans  — manually add a single plan
router.post("/", async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "Admin only" });

    const b = z.object({
      network:   z.string().min(2),
      plan_code: z.string().min(2),
      title:     z.string().optional(),
      sellPrice: z.number().min(1),
      costPrice: z.number().optional(),
      isActive:  z.boolean().optional(),
    }).parse(req.body);

    const plan = await DataPlan.findOneAndUpdate(
      { network: b.network, plan_code: b.plan_code },
      { network: b.network, plan_code: b.plan_code, title: b.title || "", sellPrice: b.sellPrice, costPrice: b.costPrice || 0, isActive: b.isActive ?? true },
      { upsert: true, new: true }
    );
    return res.json({ ok: true, plan });
  } catch (e) { next(e); }
});

router.delete("/:id", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "Admin only" });
  await DataPlan.findByIdAndUpdate(req.params.id, { isActive: false });
  return res.json({ ok: true });
});

module.exports = router;