const router = require("express").Router();
const { z } = require("zod");
const DataPlan = require("../models/DataPlan");

function isAdmin(req) {
  const key = req.headers["x-admin-key"];
  return key && process.env.ADMIN_KEY && key === process.env.ADMIN_KEY;
}

router.post("/", async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "Admin only" });

    const b = z.object({
      network: z.string().min(2),
      plan_code: z.string().min(2),
      title: z.string().optional(),
      sellPrice: z.number().min(1),
      costPrice: z.number().optional(),
      isActive: z.boolean().optional()
    }).parse(req.body);

    const plan = await DataPlan.findOneAndUpdate(
      { network: b.network, plan_code: b.plan_code },
      {
        network: b.network,
        plan_code: b.plan_code,
        title: b.title || "",
        sellPrice: b.sellPrice,
        costPrice: b.costPrice || 0,
        isActive: b.isActive ?? true
      },
      { upsert: true, new: true }
    );

    res.json({ ok: true, plan });
  } catch (e) { next(e); }
});

router.get("/:network", async (req, res) => {
  const plans = await DataPlan.find({ network: req.params.network, isActive: true }).sort({ sellPrice: 1 });
  res.json({ ok: true, plans });
});

module.exports = router;
