const express = require("express");
const router = express.Router();

const Advert = require("../models/Advert");
const { auth } = require("../middleware/auth");

function userAudience(req) {
  return String(req.user?.role || "USER").toUpperCase();
}

function activeDateFilter(now = new Date()) {
  return {
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
    ],
  };
}

// GET /api/adverts — active dashboard adverts for the logged-in user.
router.get("/", auth, async (req, res) => {
  try {
    const now = new Date();
    const audience = userAudience(req);

    const adverts = await Advert.find({
      isActive: true,
      audience: { $in: ["ALL", audience] },
      ...activeDateFilter(now),
    })
      .sort({ priority: -1, createdAt: -1 })
      .limit(8)
      .select("-__v")
      .lean();

    return res.json({ ok: true, adverts });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Record a view. Kept lightweight; duplicate views are intentionally allowed
// because this is an exposure counter, not a billing-grade impression system.
router.post("/:id/view", auth, async (req, res) => {
  try {
    await Advert.findOneAndUpdate(
      {
        _id: req.params.id,
        isActive: true,
      },
      { $inc: { views: 1 } }
    );
    return res.json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: true });
  }
});

// Record a click.
router.post("/:id/click", auth, async (req, res) => {
  try {
    const advert = await Advert.findOneAndUpdate(
      { _id: req.params.id, isActive: true },
      { $inc: { clicks: 1 } },
      { new: true }
    ).lean();

    if (!advert) return res.status(404).json({ ok: false, error: "Advert not found" });

    return res.json({ ok: true, ctaUrl: advert.ctaUrl || "" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
