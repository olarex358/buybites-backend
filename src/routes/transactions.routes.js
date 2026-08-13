const router = require("express").Router();
const { z } = require("zod");

const { auth } = require("../middleware/auth");
const Transaction = require("../models/Transaction");
const TransactionEvent = require("../models/TransactionEvent");
const { recordTransactionEvent } = require("../services/tx.events");

// Unified engine
const { createUnifiedTx } = require("../services/tx.engine");
const { scheduleTransactionProcessing } = require("../services/tx.processor");

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

    // Provider work happens in the background so the API can respond quickly.
    if (out.tx?.status === "PROCESSING" && !out.deduped) {
      scheduleTransactionProcessing(out.tx._id);
    }

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
// GET /api/tx/:id/status
// -----------------------------
router.get("/:id/status", auth, async (req, res, next) => {
  try {
    const tx = await Transaction.findOne({
      _id: req.params.id,
      userId: req.user.sub,
    })
      .select("_id type status processingStage statusMessage reference providerRef completedAt nextCheckAt requeryAttempts lastRequeryAt lastError meta token")
      .lean();

    if (!tx) return res.fail("Transaction not found", 404);

    return res.success(
      {
        status: tx.status,
        processingStage: tx.processingStage,
        statusMessage: tx.statusMessage,
        amount: tx.amount,
        sellPrice: tx.sellPrice,
        reference: tx.reference,
        providerRef: tx.providerRef,
        completedAt: tx.completedAt,
        nextCheckAt: tx.nextCheckAt,
        requeryAttempts: tx.requeryAttempts || 0,
        lastRequeryAt: tx.lastRequeryAt,
        lastError: tx.lastError || "",
        token: tx.token || tx.meta?.token || "",
      },
      "Transaction status fetched"
    );
  } catch (e) {
    next(e);
  }
});

// -----------------------------
// GET /api/tx/:id/timeline
// -----------------------------
router.get("/:id/timeline", auth, async (req, res, next) => {
  try {
    const exists = await Transaction.exists({
      _id: req.params.id,
      userId: req.user.sub,
    });

    if (!exists) return res.fail("Transaction not found", 404);

    const events = await TransactionEvent.find({
      transactionId: req.params.id,
      userId: req.user.sub,
    })
      .sort({ createdAt: 1 })
      .limit(50)
      .lean();

    return res.success({ events }, "Transaction timeline fetched");
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
// POST /api/tx/:id/requery
// -----------------------------
router.post("/:id/requery", auth, async (req, res, next) => {
  try {
    const tx = await Transaction.findOne({
      _id: req.params.id,
      userId: req.user.sub,
    });

    if (!tx) return res.fail("Transaction not found", 404);

    if (tx.status !== "PROCESSING") {
      return res.success(
        { status: tx.status, processingStage: tx.processingStage },
        "Transaction already has a final status"
      );
    }

    const lastRequery = tx.lastRequeryAt ? new Date(tx.lastRequeryAt).getTime() : 0;
    if (lastRequery && Date.now() - lastRequery < 10000) {
      return res.fail("Please wait a few seconds before checking again.", 429, {
        retryAfterMs: 10000 - (Date.now() - lastRequery),
      });
    }

    tx.lastRequeryAt = new Date();
    tx.requeryAttempts = Number(tx.requeryAttempts || 0) + 1;
    await tx.save();

    const { requeryTransaction } = require("../services/provider.requery");
    const result = await requeryTransaction(tx);

    if (!result.supported) {
      tx.processingStage = "PROVIDER_UNKNOWN";
      tx.statusMessage = "The provider does not expose a direct status check. NEX will continue monitoring automatically.";
      tx.nextCheckAt = new Date(Date.now() + 60 * 1000);
      await tx.save();

      await recordTransactionEvent(tx, {
        status: "PROCESSING",
        processingStage: "PROVIDER_UNKNOWN",
        message: tx.statusMessage,
        source: "REQUERY",
      });

      return res.fail(
        "This provider does not expose a configured status-requery method yet.",
        501,
        { supported: false, status: tx.status, processingStage: tx.processingStage }
      );
    }

    if (result.status === "SUCCESS") {
      const { finalizeSuccess } = require("../services/tx.lifecycle");
      await finalizeSuccess(tx, {
        providerRef: result.providerRef,
        token: result.token,
      });
    } else if (result.status === "FAILED") {
      const { finalizeRefund } = require("../services/tx.lifecycle");
      await finalizeRefund(tx, result.message || "Provider confirmed the transaction failed.");
    } else {
      tx.processingStage = "PROVIDER_UNKNOWN";
      tx.statusMessage = "The provider has not confirmed completion yet.";
      tx.nextCheckAt = new Date(Date.now() + 60 * 1000);
      await tx.save();

      await recordTransactionEvent(tx, {
        status: "PROCESSING",
        processingStage: "PROVIDER_UNKNOWN",
        message: tx.statusMessage,
        source: "REQUERY",
        providerRef: tx.providerRef,
        meta: { manual: true },
      });
    }

    return res.success(
      {
        status: tx.status,
        processingStage: tx.processingStage,
        statusMessage: tx.statusMessage,
        reference: tx.reference,
        providerRef: tx.providerRef,
        token: result.token || tx.meta?.token || "",
      },
      "Transaction status checked"
    );
  } catch (e) {
    next(e);
  }
});

module.exports = router;