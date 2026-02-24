const router = require("express").Router();
const { z } = require("zod");

const { auth } = require("../middleware/auth");
const Transaction = require("../models/Transaction");

// Unified engine
const { createUnifiedTx } = require("../services/tx.engine");

// Helpers
const normalizeType = (t) => {
  const v = String(t || "").toUpperCase().trim();
  // accept "CABLE" from frontend but store/filter as "TV" per your model
  if (v === "CABLE") return "TV";
  return v;
};

const normalizeStatus = (s) => String(s || "").toUpperCase().trim();

// -----------------------------
// POST /api/tx/create  (kept)
// -----------------------------
router.post("/create", auth, async (req, res, next) => {
  try {
    const b = z
      .object({
        serviceType: z.string().optional(),
        network: z.string().optional(),
        productCode: z.string().optional(),
        meta: z.any().optional(),

        // backward compat
        type: z.string().optional(),
        amount: z.number().optional(),
      })
      .passthrough()
      .parse(req.body);

    const serviceType = normalizeType(b.serviceType || b.type);

    const normalized = {
      serviceType,
      network: b.network || b.meta?.network,
      productCode: b.productCode || b.meta?.plan_code || b.meta?.productCode,
      meta: b.meta || {},
    };

    // common normalizations
    if (serviceType === "DATA" || serviceType === "AIRTIME") {
      normalized.meta.mobile_number =
        normalized.meta.mobile_number ||
        normalized.meta.phone ||
        normalized.meta.recipient;
    }

    const out = await createUnifiedTx({
      userId: req.user.sub,
      body: normalized,
      headers: req.headers,
    });

    return res.success(
      { tx: out.tx, provider: out.provider, token: out.token || "", deduped: !!out.deduped },
      "Transaction created"
    );
  } catch (e) {
    next(e);
  }
});

// -----------------------------
// GET /api/tx  (NEW - list)
// -----------------------------
router.get("/", auth, async (req, res, next) => {
  try {
    const q = z
      .object({
        page: z.string().optional(),
        limit: z.string().optional(),
        type: z.string().optional(),     // DATA/AIRTIME/ELECTRICITY/TV/...
        status: z.string().optional(),   // PROCESSING/SUCCESS/FAILED/REFUNDED
        from: z.string().optional(),     // ISO date
        to: z.string().optional(),       // ISO date
      })
      .passthrough()
      .parse(req.query);

    const page = Math.max(parseInt(q.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(q.limit || "20", 10), 1), 100);
    const skip = (page - 1) * limit;

    const filter = { userId: req.user.sub };

    if (q.type) filter.type = normalizeType(q.type);
    if (q.status) filter.status = normalizeStatus(q.status);

    if (q.from || q.to) {
      filter.createdAt = {};
      if (q.from) filter.createdAt.$gte = new Date(q.from);
      if (q.to) filter.createdAt.$lte = new Date(q.to);
    }

    const [items, total] = await Promise.all([
      Transaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Transaction.countDocuments(filter),
    ]);

    return res.success(
      { items },
      "Transactions fetched",
      { page, limit, total, pages: Math.ceil(total / limit) }
    );
  } catch (e) {
    next(e);
  }
});

// -----------------------------
// GET /api/tx/my (kept)
// -----------------------------
router.get("/my", auth, async (req, res, next) => {
  try {
    const txs = await Transaction.find({ userId: req.user.sub })
      .sort({ createdAt: -1 })
      .limit(50);

    return res.success({ txs }, "Transactions fetched");
  } catch (e) {
    next(e);
  }
});

// -----------------------------
// GET /api/tx/summary (NEW)
// -----------------------------
router.get("/summary", auth, async (req, res, next) => {
  try {
    const userId = req.user.sub;

    const rows = await Transaction.aggregate([
      { $match: { userId } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          totalAmount: { $sum: { $ifNull: ["$amount", 0] } },
        },
      },
    ]);

    const byStatus = {};
    for (const r of rows) {
      byStatus[r._id] = { count: r.count, totalAmount: r.totalAmount };
    }

    const totalCount = rows.reduce((a, r) => a + r.count, 0);
    const successCount = byStatus.SUCCESS?.count || 0;

    const successRate = totalCount
      ? Math.round((successCount / totalCount) * 100)
      : 0;

    return res.success(
      { totalCount, successCount, successRate, byStatus },
      "Summary fetched"
    );
  } catch (e) {
    next(e);
  }
});

// -----------------------------
// GET /api/tx/:id (NEW - receipt)
// -----------------------------
router.get("/:id", auth, async (req, res, next) => {
  try {
    const tx = await Transaction.findOne({
      _id: req.params.id,
      userId: req.user.sub,
    });

    if (!tx) return res.fail("Transaction not found", 404);
    return res.success({ tx }, "Transaction fetched");
  } catch (e) {
    next(e);
  }
});

// -----------------------------
// POST /api/tx/:id/requery (NEW - stub)
// -----------------------------
router.post("/:id/requery", auth, async (req, res, next) => {
  try {
    const tx = await Transaction.findOne({
      _id: req.params.id,
      userId: req.user.sub,
    });

    if (!tx) return res.fail("Transaction not found", 404);

    // Provider requery depends on Peyflex endpoint.
    // Keep stable API for frontend now.
    return res.fail("Requery not implemented yet for this provider", 501, { tx });
  } catch (e) {
    next(e);
  }
});

module.exports = router;