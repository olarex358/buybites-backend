const router = require("express").Router();
const { z } = require("zod");
const { adminOnly } = require("../middleware/admin");

const User = require("../models/User");
const WalletTx = require("../models/WalletTx");
const Order = require("../models/Order");
const DataPlan = require("../models/DataPlan");
const Complaint = require("../models/Complaint");
const SupportMessage = require("../models/SupportMessage");

function pageParams(q) {
  const page = Math.max(1, Number(q.page || 1));
  const limit = Math.min(50, Math.max(5, Number(q.limit || 20)));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

router.use(adminOnly);

/** Dashboard stats */
router.get("/stats", async (req, res) => {
  const [users, orders, walletTx, openComplaints] = await Promise.all([
    User.countDocuments(),
    Order.countDocuments(),
    WalletTx.countDocuments(),
    Complaint.countDocuments({ status: { $ne: "RESOLVED" } })
  ]);

  const [delivered, refunded, processing] = await Promise.all([
    Order.countDocuments({ status: "DELIVERED" }),
    Order.countDocuments({ status: "REFUNDED" }),
    Order.countDocuments({ status: "PROCESSING" })
  ]);

  res.json({
    ok: true,
    stats: { users, orders, walletTx, openComplaints, delivered, refunded, processing }
  });
});

/** Users list + search */
router.get("/users", async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const search = String(req.query.search || "").trim();

  const query = search
    ? { $or: [{ phone: new RegExp(search, "i") }, { fullName: new RegExp(search, "i") }] }
    : {};

  const [total, items] = await Promise.all([
    User.countDocuments(query),
    User.find(query).select("phone fullName walletBalance isBlocked createdAt").sort({ createdAt: -1 }).skip(skip).limit(limit)
  ]);

  res.json({ ok: true, page, limit, total, items });
});

/** Orders list + filters */
router.get("/orders", async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const status = String(req.query.status || "").trim(); // DELIVERED/PROCESSING/FAILED/REFUNDED
  const phone = String(req.query.phone || "").trim();

  const q = {};
  if (status) q.status = status;
  if (phone) q.mobile_number = new RegExp(phone, "i");

  const [total, items] = await Promise.all([
    Order.countDocuments(q),
    Order.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit)
  ]);

  res.json({ ok: true, page, limit, total, items });
});

/** Wallet transactions list */
router.get("/wallet-tx", async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const ref = String(req.query.ref || "").trim();
  const type = String(req.query.type || "").trim();

  const q = {};
  if (ref) q.reference = new RegExp(ref, "i");
  if (type) q.type = type;

  const [total, items] = await Promise.all([
    WalletTx.countDocuments(q),
    WalletTx.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit)
  ]);

  res.json({ ok: true, page, limit, total, items });
});

/** Plans list + toggle active */
router.get("/plans", async (req, res) => {
  const items = await DataPlan.find().sort({ updatedAt: -1 });
  res.json({ ok: true, items });
});

router.patch("/plans/:id", async (req, res, next) => {
  try {
    const b = z.object({
      sellPrice: z.number().min(1).optional(),
      costPrice: z.number().min(0).optional(),
      isActive: z.boolean().optional(),
      title: z.string().optional()
    }).parse(req.body);

    const plan = await DataPlan.findByIdAndUpdate(req.params.id, b, { new: true });
    if (!plan) return res.status(404).json({ ok: false, error: "Plan not found" });
    res.json({ ok: true, plan });
  } catch (e) { next(e); }
});

/** Complaints / tickets */
router.post("/complaints", async (req, res, next) => {
  try {
    const b = z.object({
      phone: z.string().optional(),
      category: z.string().optional(),
      subject: z.string().optional(),
      message: z.string().min(5),
      priority: z.enum(["LOW","MEDIUM","HIGH"]).optional()
    }).parse(req.body);

    const ticket = await Complaint.create({
      phone: b.phone || "",
      category: b.category || "general",
      subject: b.subject || "",
      message: b.message,
      priority: b.priority || "MEDIUM"
    });

    await SupportMessage.create({ ticketId: ticket._id, sender: "USER", message: b.message });

    res.json({ ok: true, ticket });
  } catch (e) { next(e); }
});

router.get("/complaints", async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const status = String(req.query.status || "").trim();
  const q = status ? { status } : {};
  const [total, items] = await Promise.all([
    Complaint.countDocuments(q),
    Complaint.find(q).sort({ updatedAt: -1 }).skip(skip).limit(limit)
  ]);
  res.json({ ok: true, page, limit, total, items });
});

router.get("/complaints/:id", async (req, res) => {
  const ticket = await Complaint.findById(req.params.id);
  if (!ticket) return res.status(404).json({ ok: false, error: "Ticket not found" });

  const messages = await SupportMessage.find({ ticketId: ticket._id }).sort({ createdAt: 1 });
  res.json({ ok: true, ticket, messages });
});

router.post("/complaints/:id/reply", async (req, res, next) => {
  try {
    const b = z.object({ message: z.string().min(2) }).parse(req.body);

    const ticket = await Complaint.findById(req.params.id);
    if (!ticket) return res.status(404).json({ ok: false, error: "Ticket not found" });

    ticket.status = "IN_PROGRESS";
    ticket.adminReply = b.message;
    await ticket.save();

    await SupportMessage.create({ ticketId: ticket._id, sender: "ADMIN", message: b.message });

    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post("/complaints/:id/resolve", async (req, res) => {
  const ticket = await Complaint.findById(req.params.id);
  if (!ticket) return res.status(404).json({ ok: false, error: "Ticket not found" });

  ticket.status = "RESOLVED";
  ticket.resolvedAt = new Date();
  await ticket.save();

  res.json({ ok: true });
});

module.exports = router;
