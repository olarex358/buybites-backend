const router    = require("express").Router();
const { z }     = require("zod");
const DataPlan  = require("../models/DataPlan");
const { peyflexClient } = require("../services/peyflex.service");

// ─── admin key check ───────────────────────────────────────────
function isAdmin(req) {
  const key = req.headers["x-admin-key"];
  return key && process.env.ADMIN_KEY && key === process.env.ADMIN_KEY;
}

// ─── network name normalizer ───────────────────────────────────
// Peyflex may return network names in different formats
// We normalize everything to our internal plan_code prefix format
const NETWORK_MAP = {
  mtn:     "mtn_sme_data",
  glo:     "glo_sme_data",
  airtel:  "airtel_sme_data",
  "9mobile": "9mobile_sme_data",
  etisalat: "9mobile_sme_data",
};

function normalizeNetwork(raw = "") {
  const lower = String(raw).toLowerCase().trim();
  return NETWORK_MAP[lower] || lower;
}

// ─────────────────────────────────────────────────────────────────
//  GET /api/plans/:network
//  Public — frontend fetches plans by network
//  network param: MTN | GLO | AIRTEL | 9MOBILE
// ─────────────────────────────────────────────────────────────────
router.get("/:network", async (req, res) => {
  try {
    const raw     = String(req.params.network || "").toLowerCase().trim();
    const network = NETWORK_MAP[raw] || raw;

    const plans = await DataPlan.find({ network, isActive: true })
      .sort({ sellPrice: 1 })
      .lean();

    return res.json({ ok: true, plans });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  POST /api/plans/sync
//  Admin only — pulls plans from Peyflex and upserts into DataPlan
//  Header: x-admin-key: YOUR_ADMIN_KEY
//  Body: { network: "mtn" }  OR omit to sync all networks
// ─────────────────────────────────────────────────────────────────
router.post("/sync", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }

  const networksToSync = req.body?.network
    ? [String(req.body.network).toLowerCase().trim()]
    : ["mtn", "glo", "airtel", "9mobile"];

  const api = peyflexClient();
  const results = [];

  for (const net of networksToSync) {
    try {
      // Fetch from Peyflex
      const r = await api.get(`/api/data/plans/?network=${encodeURIComponent(net)}`);
      const raw = r.data;

      // Peyflex may return { results: [...] } or { plans: [...] } or just an array
      const list = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.results)
        ? raw.results
        : Array.isArray(raw?.plans)
        ? raw.plans
        : Array.isArray(raw?.data)
        ? raw.data
        : [];

      if (!list.length) {
        results.push({ network: net, synced: 0, error: "No plans returned from Peyflex" });
        continue;
      }

      let synced = 0;

      for (const item of list) {
        // Normalize fields — Peyflex may use different field names
        const plan_code  = String(item.plan_code || item.code || item.id || "").trim();
        const title      = String(item.name || item.title || item.description || plan_code).trim();
        const sellPrice  = Number(item.price || item.amount || item.selling_price || 0);
        const costPrice  = Number(item.cost_price || item.cost || 0);
        const network_key = normalizeNetwork(item.network || net);

        if (!plan_code || !sellPrice) continue; // skip invalid entries

        await DataPlan.findOneAndUpdate(
          { network: network_key, plan_code },
          {
            network:    network_key,
            plan_code,
            title,
            sellPrice,
            costPrice,
            isActive: true,
          },
          { upsert: true, new: true }
        );

        synced++;
      }

      results.push({ network: net, synced });
    } catch (e) {
      results.push({ network: net, synced: 0, error: e?.response?.data || e.message });
    }
  }

  const totalSynced = results.reduce((a, r) => a + (r.synced || 0), 0);
  return res.json({ ok: true, totalSynced, results });
});

// ─────────────────────────────────────────────────────────────────
//  POST /api/plans
//  Admin only — manually add/update a single plan
// ─────────────────────────────────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Admin only" });
    }

    const b = z.object({
      network:    z.string().min(2),
      plan_code:  z.string().min(2),
      title:      z.string().optional(),
      sellPrice:  z.number().min(1),
      costPrice:  z.number().optional(),
      isActive:   z.boolean().optional(),
    }).parse(req.body);

    const plan = await DataPlan.findOneAndUpdate(
      { network: b.network, plan_code: b.plan_code },
      {
        network:    b.network,
        plan_code:  b.plan_code,
        title:      b.title || "",
        sellPrice:  b.sellPrice,
        costPrice:  b.costPrice || 0,
        isActive:   b.isActive ?? true,
      },
      { upsert: true, new: true }
    );

    return res.json({ ok: true, plan });
  } catch (e) {
    next(e);
  }
});

// ─────────────────────────────────────────────────────────────────
//  DELETE /api/plans/:id
//  Admin only — deactivate a plan
// ─────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }
  await DataPlan.findByIdAndUpdate(req.params.id, { isActive: false });
  return res.json({ ok: true });
});

module.exports = router;
