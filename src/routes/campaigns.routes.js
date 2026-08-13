const express = require("express");
const router = express.Router();

const Campaign = require("../models/Campaign");
const CampaignReward = require("../models/CampaignReward");
const { auth } = require("../middleware/auth");

function userAudience(req) {
  return String(req.user?.role || "USER").toUpperCase();
}

function activeWindow(now = new Date()) {
  return {
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
    ],
  };
}

// Customer-facing active campaigns.
router.get("/", auth, async (req, res) => {
  try {
    const now = new Date();
    const audience = userAudience(req);
    const tier = String(req.user?.tier || "USER").toUpperCase();

    const campaigns = await Campaign.find({
      isActive: true,
      audience: { $in: ["ALL", audience] },
      tier: { $in: ["ANY", tier] },
      ...activeWindow(now),
    })
      .sort({ priority: -1, createdAt: -1 })
      .limit(20)
      .select(
        "title description type rewardType rewardValue maxReward minTransactionAmount imageUrl ctaText ctaUrl priority serviceTypes tier perUserLimit"
      )
      .lean();

    const onceCampaignIds = campaigns
      .filter((campaign) => Number(campaign.perUserLimit) === 1)
      .map((campaign) => campaign._id);

    const claimed = onceCampaignIds.length
      ? await CampaignReward.find({
          userId: req.user.sub,
          campaignId: { $in: onceCampaignIds },
          status: "PAID",
        })
          .select("campaignId")
          .lean()
      : [];

    const claimedIds = new Set(claimed.map((row) => String(row.campaignId)));

    const visible = campaigns.filter(
      (campaign) =>
        Number(campaign.perUserLimit) !== 1 ||
        !claimedIds.has(String(campaign._id))
    );

    return res.json({ ok: true, campaigns: visible.slice(0, 8) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/:id/view", auth, async (req, res) => {
  try {
    await Campaign.findOneAndUpdate(
      { _id: req.params.id, isActive: true },
      { $inc: { views: 1 } }
    );
    return res.json({ ok: true });
  } catch {
    return res.json({ ok: true });
  }
});

router.post("/:id/click", auth, async (req, res) => {
  try {
    const campaign = await Campaign.findOneAndUpdate(
      { _id: req.params.id, isActive: true },
      { $inc: { clicks: 1 } },
      { new: true }
    ).lean();

    if (!campaign) {
      return res.status(404).json({ ok: false, error: "Campaign not found" });
    }

    return res.json({ ok: true, ctaUrl: campaign.ctaUrl || "" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
