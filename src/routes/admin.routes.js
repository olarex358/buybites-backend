const Campaign = require("../models/Campaign");
const CampaignReward = require("../models/CampaignReward");
const { applyCampaignReward } = require("../services/campaign.service");
const { awardLoyaltyPoints, rankForVolume, LEVELS, AGENT_RANKS } = require("../services/loyalty.service");
const { notifyTransactionStatus } = require("../services/notification.service");
const { recordTransactionEvent } = require("../services/tx.events");
const {
  getPeyflexFundingStatus,
} = require("../services/peyflex.funding.service");
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { getPeyflexBalance } = require("../services/providers/peyflex.provider");
const {
  getKorapayBalance,
} = require("../services/korapay.transfer.service");
const User = require("../models/User");
const Advert = require("../models/Advert");
const DataPlan = require("../models/DataPlan");
const Pricing = require("../models/Pricing");
const Order = require("../models/Order");
const WalletTx = require("../models/WalletTx");
const Transaction = require("../models/Transaction");
const ProviderFunding = require("../models/ProviderFunding");
const { auth } = require("../middleware/auth");
const { getAllProviderHealth } = require("../services/provider.health");

// ── ADMIN FINANCIAL MONITOR CONFIG ─────────────────────────────
// Manual provider balances are persisted in MongoDB.
const adminMonitorSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      unique: true,
      default: "MAIN",
    },

    korapay: {
      type: Number,
      default: 0,
      min: 0,
    },

    peyflex: {
      type: Number,
      default: 0,
      min: 0,
    },

    sme: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
    collection: "admin_monitor",
  }
);

const AdminMonitor =
  mongoose.models.AdminMonitor ||
  mongoose.model("AdminMonitor", adminMonitorSchema);

function isAdminKey(req) {
  const key = req.headers["x-admin-key"];
  return key && process.env.ADMIN_KEY && key === process.env.ADMIN_KEY;
}

function requireAdminRole(req, res, next) {
  if ((req.user?.role || "").toUpperCase() !== "ADMIN") {
    return res.status(403).json({
      ok: false,
      error: "Admin access required",
    });
  }

  next();
}

function normalizePhone(raw) {
  let p = String(raw || "").replace(/\D/g, "").trim();

  if (p.startsWith("0") && p.length === 11) {
    p = "234" + p.slice(1);
  } else if (p.startsWith("234") && p.length === 13) {
    // already normalized
  } else if (p.length === 10) {
    p = "234" + p;
  }

  return p;
}

// ── POST /api/admin/setup ─────────────────────────────────────
router.post("/setup", async (req, res) => {
  try {
    if (!isAdminKey(req)) {
      return res.status(403).json({
        ok: false,
        error: "Invalid admin key",
      });
    }

    const { phone: rawPhone, pin } = req.body;

    if (!rawPhone || !pin) {
      return res.status(400).json({
        ok: false,
        error: "phone and pin required",
      });
    }

    const pinStr = String(pin).replace(/\D/g, "");

    if (!/^\d{4,8}$/.test(pinStr)) {
      return res.status(400).json({
        ok: false,
        error: "PIN must be 4-8 digits",
      });
    }

    const existingAdmin = await User.findOne({
      role: "ADMIN",
    });

    if (existingAdmin) {
      return res.status(409).json({
        ok: false,
        error: "Admin already exists. Login with phone + PIN normally.",
        phone: existingAdmin.phone,
      });
    }

    const phone = normalizePhone(rawPhone);
    const existingUser = await User.findOne({ phone });

    if (existingUser) {
      existingUser.role = "ADMIN";
      await existingUser.save();

      return res.json({
        ok: true,
        message: `✅ ${phone} promoted to ADMIN. Login with your existing PIN.`,
        user: {
          _id: existingUser._id,
          phone: existingUser.phone,
          role: existingUser.role,
        },
      });
    }

    const pinHash = await bcrypt.hash(pinStr, 12);

    const admin = await User.create({
      phone,
      pinHash,
      role: "ADMIN",
      walletBalance: 0,
      isVerified: true,
      failedLoginAttempts: 0,
    });

    return res.json({
      ok: true,
      message: `✅ Admin created for ${phone}. Login with phone + PIN.`,
      user: {
        _id: admin._id,
        phone: admin.phone,
        role: admin.role,
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
});

// ── GET /api/admin/transactions ───────────────────────────────
router.get("/transactions", auth, requireAdminRole, async (req, res) => {
  try {
    const page = Math.max(
      parseInt(req.query.page || "1", 10),
      1
    );

    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "30", 10), 1),
      100
    );

    const filter = {};

    if (req.query.status) {
      filter.status = String(req.query.status).toUpperCase();
    }

    if (req.query.type) {
      filter.type = String(req.query.type).toUpperCase();
    }

    if (req.query.provider) {
      filter.provider = String(req.query.provider).toUpperCase();
    }

    if (req.query.stage) {
      filter.processingStage = String(req.query.stage).toUpperCase();
    }

    const [items, total] = await Promise.all([
      Transaction.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("userId", "fullName phone role tier")
        .lean(),

      Transaction.countDocuments(filter),
    ]);

    return res.json({
      ok: true,
      items,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
});

// ── GET /api/admin/retention ─────────────────────────────────
router.get("/retention", auth, requireAdminRole, async (req, res) => {
  try {
    const now = Date.now();

    const d1 = new Date(
      now - 24 * 60 * 60 * 1000
    );

    const d7 = new Date(
      now - 7 * 24 * 60 * 60 * 1000
    );

    const d30 = new Date(
      now - 30 * 24 * 60 * 60 * 1000
    );

    const [
      active24h,
      active7d,
      active30d,
      referredUsers,
      convertedReferrals,
      rewardRows,
      repeatBuyers,
      successfulUsers,
    ] = await Promise.all([
      User.countDocuments({
        role: { $ne: "ADMIN" },
        lastActiveAt: { $gte: d1 },
      }),

      User.countDocuments({
        role: { $ne: "ADMIN" },
        lastActiveAt: { $gte: d7 },
      }),

      User.countDocuments({
        role: { $ne: "ADMIN" },
        lastActiveAt: { $gte: d30 },
      }),

      User.countDocuments({
        role: { $ne: "ADMIN" },
        referredBy: { $nin: [null, ""] },
      }),

      User.countDocuments({
        role: { $ne: "ADMIN" },
        referredBy: { $nin: [null, ""] },
        referralBonusPaid: true,
      }),

      WalletTx.aggregate([
        {
          $match: {
            type: "CREDIT",
            "meta.reward": "REFERRER_BONUS",
            status: "SUCCESS",
          },
        },

        {
          $group: {
            _id: null,
            total: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
      ]),

      Transaction.aggregate([
        {
          $match: {
            status: "SUCCESS",
            type: {
              $in: [
                "DATA",
                "AIRTIME",
                "ELECTRICITY",
                "TV",
                "CABLE",
              ],
            },
          },
        },

        {
          $group: {
            _id: "$userId",
            count: { $sum: 1 },
            volume: {
              $sum: {
                $ifNull: ["$sellPrice", "$amount"],
              },
            },
          },
        },

        {
          $match: {
            count: { $gte: 2 },
          },
        },

        {
          $count: "count",
        },
      ]),

      Transaction.aggregate([
        {
          $match: {
            status: "SUCCESS",
            type: {
              $in: [
                "DATA",
                "AIRTIME",
                "ELECTRICITY",
                "TV",
                "CABLE",
              ],
            },
          },
        },

        {
          $group: {
            _id: "$userId",
          },
        },

        {
          $count: "count",
        },
      ]),
    ]);

    const referralRate = referredUsers
      ? Number(
          (
            (convertedReferrals / referredUsers) *
            100
          ).toFixed(1)
        )
      : 0;

    return res.json({
      ok: true,

      retention: {
        active24h,
        active7d,
        active30d,

        repeatBuyers:
          repeatBuyers[0]?.count || 0,

        successfulCustomers:
          successfulUsers[0]?.count || 0,

        referredUsers,
        convertedReferrals,

        referralConversionRate:
          referralRate,

        referralRewardsPaid:
          rewardRows[0]?.total || 0,

        referralRewardsCount:
          rewardRows[0]?.count || 0,

        asOf: new Date().toISOString(),
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
});

// ── GET /api/admin/provider-health ────────────────────────────
router.get(
  "/provider-health",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const {
        recommend,
        healthSnapshot,
      } = require("../services/provider.router");

      const service = String(
        req.query.service || ""
      )
        .toUpperCase()
        .trim();

      if (service) {
        const [
          items,
          recommendation,
        ] = await Promise.all([
          healthSnapshot({ service }),
          recommend({ service }),
        ]);

        return res.json({
          ok: true,
          service,
          items,
          recommendation,
        });
      }

      const items =
        await getAllProviderHealth();

      const {
        configuredOrder,
      } = require("../services/provider.router");

      return res.json({
        ok: true,
        items,

        configuredOrder: {
          DATA: configuredOrder("DATA"),
          AIRTIME: configuredOrder("AIRTIME"),
          ELECTRICITY:
            configuredOrder("ELECTRICITY"),
          CABLE: configuredOrder("CABLE"),
        },
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ── POST /api/admin/provider-health/reset ─────────────────────
router.post(
  "/provider-health/reset",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const ProviderHealth =
        require("../models/ProviderHealth");

      const provider = String(
        req.body.provider || ""
      )
        .toUpperCase()
        .trim();

      const service = String(
        req.body.service || ""
      )
        .toUpperCase()
        .trim();

      if (!provider || !service) {
        return res.status(400).json({
          ok: false,
          error:
            "provider and service are required",
        });
      }

      const row =
        await ProviderHealth.findOneAndUpdate(
          {
            provider,
            service,
          },

          {
            $set: {
              consecutiveFailures: 0,
              circuitOpenUntil: null,
              lastOutcome: "",
            },
          },

          {
            new: true,
          }
        ).lean();

      if (!row) {
        return res.status(404).json({
          ok: false,
          error:
            "Provider health record not found",
        });
      }

      return res.json({
        ok: true,

        message:
          `${provider}/${service} circuit reset`,

        item: row,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ── FINANCIAL HEALTH MONITOR ─────────────────────────────────

// GET /api/admin/monitor
router.get(
  "/monitor",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const [
  config,
  liabilityRows,
  peyflexResult,
  korapayResult,
] = await Promise.all([  AdminMonitor.findOne({
          key: "MAIN",
        }).lean(),

        User.aggregate([
          {
            $match: {
              role: { $ne: "ADMIN" },
            },
          },
          {
            $group: {
              _id: null,

              liability: {
                $sum: {
                  $ifNull: [
                    "$walletBalance",
                    0,
                  ],
                },
              },
            },
          },
        ]),

        // Fetch the REAL Peyflex wallet balance
        getPeyflexBalance().catch((err) => {
          console.error(
            "[admin/monitor] Peyflex balance fetch failed:",
            err.message
          );

          return null;
        }),
        getKorapayBalance().catch((err) => {
  console.error(
    "[admin/monitor] Korapay balance fetch failed:",
    err.message
  );

  return null;
}),
      ]);

   const korapay =
  korapayResult?.status === true &&
  Number.isFinite(
    Number(
      korapayResult?.data?.NGN?.available_balance
    )
  )
    ? Number(
        korapayResult.data.NGN.available_balance
      )
    : Number(config?.korapay || 0);
      // SMEData remains manual for now
      const sme = Number(
        config?.sme || 0
      );

      // Use live Peyflex balance when available.
      // Fall back to the previously stored manual value if
      // Peyflex cannot be reached.
      const peyflex =
        peyflexResult &&
        Number.isFinite(
          Number(peyflexResult.balance)
        )
          ? Number(peyflexResult.balance)
          : Number(config?.peyflex || 0);

      const liability = Number(
        liabilityRows[0]?.liability || 0
      );

      const totalAssets =
        korapay +
        peyflex +
        sme;

      return res.json({
        ok: true,

        data: {
          korapay,
          peyflex,
          sme,

          totalAssets,

          liability,

          assetSurplus:
            totalAssets -
            liability,

          // Peyflex is now automatic.
          autoSync: true,

          source: "PEYFLEX_LIVE",

          updatedAt:
            config?.updatedAt || null,
        },
      });
    } catch (e) {
      console.error(
        "[admin/monitor] GET:",
        e
      );

      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);
// POST /api/admin/monitor/update
router.post(
  "/monitor/update",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const values = {
        korapay: Number(
          req.body?.korapay
        ),

        peyflex: Number(
          req.body?.peyflex
        ),

        sme: Number(
          req.body?.sme
        ),
      };

      for (
        const [name, value]
        of Object.entries(values)
      ) {
        if (
          !Number.isFinite(value) ||
          value < 0
        ) {
          return res.status(400).json({
            ok: false,

            error:
              `${name} balance must be a valid non-negative number`,
          });
        }
      }

      const config =
        await AdminMonitor.findOneAndUpdate(
          {
            key: "MAIN",
          },

          {
            $set: values,
          },

          {
            new: true,
            upsert: true,
            setDefaultsOnInsert: true,
            runValidators: true,
          }
        ).lean();

      return res.json({
        ok: true,

        message:
          "Financial monitor balances updated successfully",

        data: {
          korapay:
            Number(
              config.korapay || 0
            ),

          peyflex:
            Number(
              config.peyflex || 0
            ),

          sme:
            Number(
              config.sme || 0
            ),
        },
      });
    } catch (e) {
      console.error(
        "[admin/monitor] UPDATE:",
        e
      );

      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ── GET /api/admin/stats ──────────────────────────────────────
router.get(
  "/stats",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const [
        users,
        legacyOrders,
        txOrders,
        walletTx,
        activePlans,

        legacyDelivered,
        txSuccess,

        legacyProcessing,
        txProcessing,

        legacyFailed,
        txFailed,

        legacyRefunded,
        txRefunded,
      ] = await Promise.all([
        User.countDocuments({
          role: { $ne: "ADMIN" },
        }),

        Order.countDocuments({}),

        Transaction.countDocuments({}),

        WalletTx.countDocuments({
          type: "CREDIT",
          status: "SUCCESS",
        }),

        DataPlan.countDocuments({
          isActive: true,
        }),

        Order.countDocuments({
          status: "DELIVERED",
        }),

        Transaction.countDocuments({
          status: "SUCCESS",
        }),

        Order.countDocuments({
          status: "PROCESSING",
        }),

        Transaction.countDocuments({
          status: "PROCESSING",
        }),

        Order.countDocuments({
          status: "FAILED",
        }),

        Transaction.countDocuments({
          status: "FAILED",
        }),

        Order.countDocuments({
          status: "REFUNDED",
        }),

        Transaction.countDocuments({
          status: "REFUNDED",
        }),
      ]);

      return res.json({
        ok: true,

        stats: {
          users,

          orders:
            legacyOrders +
            txOrders,

          walletTx,

          activePlans,

          delivered:
            legacyDelivered +
            txSuccess,

          processing:
            legacyProcessing +
            txProcessing,

          failed:
            legacyFailed +
            txFailed,

          refunded:
            legacyRefunded +
            txRefunded,
        },
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ── ADVERTISEMENT MANAGEMENT ─────────────────────────────────

router.get(
  "/adverts",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const adverts =
        await Advert.find({})
          .sort({
            priority: -1,
            createdAt: -1,
          })
          .lean();

      return res.json({
        ok: true,
        adverts,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

router.post(
  "/adverts",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const {
        title,
        description = "",
        imageUrl = "",
        ctaText = "Learn More",
        ctaUrl = "",
        audience = "ALL",
        priority = 0,
        isActive = true,
        startsAt = null,
        endsAt = null,
      } = req.body;

      if (!String(title || "").trim()) {
        return res.status(400).json({
          ok: false,
          error:
            "Advert title is required",
        });
      }

      const advert =
        await Advert.create({
          title:
            String(title).trim(),

          description:
            String(
              description || ""
            ).trim(),

          imageUrl:
            String(
              imageUrl || ""
            ).trim(),

          ctaText:
            String(
              ctaText ||
              "Learn More"
            ).trim(),

          ctaUrl:
            String(
              ctaUrl || ""
            ).trim(),

          audience:
            String(
              audience ||
              "ALL"
            ).toUpperCase(),

          priority:
            Math.min(
              100,
              Math.max(
                0,
                Number(priority || 0)
              )
            ),

          isActive:
            !!isActive,

          startsAt:
            startsAt
              ? new Date(startsAt)
              : null,

          endsAt:
            endsAt
              ? new Date(endsAt)
              : null,
        });

      return res.status(201).json({
        ok: true,
        advert,
      });
    } catch (e) {
      return res.status(400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

router.put(
  "/adverts/:id",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const allowed = [
        "title",
        "description",
        "imageUrl",
        "ctaText",
        "ctaUrl",
        "audience",
        "priority",
        "isActive",
        "startsAt",
        "endsAt",
      ];

      const update = {};

      for (
        const key of allowed
      ) {
        if (
          req.body[key] !==
          undefined
        ) {
          update[key] =
            req.body[key];
        }
      }

      if (
        update.audience !==
        undefined
      ) {
        update.audience =
          String(
            update.audience
          ).toUpperCase();
      }

      if (
        update.priority !==
        undefined
      ) {
        update.priority =
          Math.min(
            100,
            Math.max(
              0,
              Number(
                update.priority
              )
            )
          );
      }

      if (
        update.startsAt !==
        undefined
      ) {
        update.startsAt =
          update.startsAt
            ? new Date(
                update.startsAt
              )
            : null;
      }

      if (
        update.endsAt !==
        undefined
      ) {
        update.endsAt =
          update.endsAt
            ? new Date(
                update.endsAt
              )
            : null;
      }

      const advert =
        await Advert.findByIdAndUpdate(
          req.params.id,

          {
            $set: update,
          },

          {
            new: true,
            runValidators: true,
          }
        ).lean();

      if (!advert) {
        return res.status(404).json({
          ok: false,
          error:
            "Advert not found",
        });
      }

      return res.json({
        ok: true,
        advert,
      });
    } catch (e) {
      return res.status(400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

router.delete(
  "/adverts/:id",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const advert =
        await Advert.findByIdAndDelete(
          req.params.id
        ).lean();

      if (!advert) {
        return res.status(404).json({
          ok: false,
          error:
            "Advert not found",
        });
      }

      return res.json({
        ok: true,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ── CAMPAIGN / CASHBACK MANAGEMENT ──────────────────────────

router.get(
  "/campaigns",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const campaigns =
        await Campaign.find({})
          .sort({
            priority: -1,
            createdAt: -1,
          })
          .lean();

      const rewardStats =
        await CampaignReward.aggregate([
          {
            $match: {
              status: "PAID",
            },
          },

          {
            $group: {
              _id: "$campaignId",
              rewardsPaid: {
                $sum: "$amount",
              },
              claims: {
                $sum: 1,
              },
            },
          },
        ]);

      const byId = new Map(
        rewardStats.map(
          (row) => [
            String(row._id),
            {
              rewardsPaid:
                row.rewardsPaid,
              claims:
                row.claims,
            },
          ]
        )
      );

      return res.json({
        ok: true,

        campaigns:
          campaigns.map(
            (campaign) => ({
              ...campaign,

              analytics:
                byId.get(
                  String(
                    campaign._id
                  )
                ) || {
                  rewardsPaid: 0,
                  claims: 0,
                },
            })
          ),
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

router.post(
  "/campaigns",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const body =
        req.body || {};

      const title =
        String(
          body.title || ""
        ).trim();

      const name =
        String(
          body.name ||
          title
        ).trim();

      if (!title) {
        return res.status(400).json({
          ok: false,
          error:
            "Campaign title is required",
        });
      }

      const serviceTypes =
        Array.isArray(
          body.serviceTypes
        )
          ? body.serviceTypes
              .map((x) =>
                String(x).toUpperCase()
              )
              .filter(Boolean)
          : ["DATA"];

      const type =
        String(
          body.type ||
          "CASHBACK"
        ).toUpperCase();

      const audience =
        type === "AGENT_BONUS"
          ? "AGENT"
          : String(
              body.audience ||
              "ALL"
            ).toUpperCase();

      const perUserLimit =
        type === "FIRST_PURCHASE"
          ? 1
          : Number(
              body.perUserLimit ||
              0
            );

      const campaign =
        await Campaign.create({
          name,
          title,

          description:
            String(
              body.description ||
              ""
            ).trim(),

          type,

          rewardType:
            String(
              body.rewardType ||
              "FIXED"
            ).toUpperCase(),

          rewardValue:
            Math.max(
              0,
              Number(
                body.rewardValue ||
                0
              )
            ),

          maxReward:
            Math.max(
              0,
              Number(
                body.maxReward ||
                0
              )
            ),

          audience,

          tier:
            String(
              body.tier ||
              "ANY"
            ).toUpperCase(),

          serviceTypes,

          minTransactionAmount:
            Math.max(
              0,
              Number(
                body.minTransactionAmount ||
                0
              )
            ),

          perUserLimit:
            perUserLimit === 1
              ? 1
              : 0,

          budget:
            Math.max(
              0,
              Number(
                body.budget ||
                0
              )
            ),

          imageUrl:
            String(
              body.imageUrl ||
              ""
            ).trim(),

          ctaText:
            String(
              body.ctaText ||
              "Buy Now"
            ).trim(),

          ctaUrl:
            String(
              body.ctaUrl ||
              ""
            ).trim(),

          priority:
            Math.min(
              100,
              Math.max(
                0,
                Number(
                  body.priority ||
                  0
                )
              )
            ),

          isActive:
            body.isActive !== false,

          startsAt:
            body.startsAt
              ? new Date(
                  body.startsAt
                )
              : null,

          endsAt:
            body.endsAt
              ? new Date(
                  body.endsAt
                )
              : null,
        });

      return res.status(201).json({
        ok: true,
        campaign,
      });
    } catch (e) {
      return res.status(400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

router.put(
  "/campaigns/:id",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const allowed = [
        "name",
        "title",
        "description",
        "type",
        "rewardType",
        "rewardValue",
        "maxReward",
        "audience",
        "tier",
        "serviceTypes",
        "minTransactionAmount",
        "perUserLimit",
        "budget",
        "imageUrl",
        "ctaText",
        "ctaUrl",
        "priority",
        "isActive",
        "startsAt",
        "endsAt",
      ];

      const update = {};

      for (
        const key of allowed
      ) {
        if (
          req.body[key] !==
          undefined
        ) {
          update[key] =
            req.body[key];
        }
      }

      for (
        const key of [
          "type",
          "rewardType",
          "audience",
          "tier",
        ]
      ) {
        if (
          update[key] !==
          undefined
        ) {
          update[key] =
            String(
              update[key]
            ).toUpperCase();
        }
      }

      if (
        update.type ===
        "FIRST_PURCHASE"
      ) {
        update.perUserLimit = 1;
      }

      if (
        update.type ===
        "AGENT_BONUS"
      ) {
        update.audience =
          "AGENT";
      }

      if (
        update.serviceTypes !==
        undefined
      ) {
        update.serviceTypes =
          Array.isArray(
            update.serviceTypes
          )
            ? update.serviceTypes
                .map((x) =>
                  String(x).toUpperCase()
                )
                .filter(Boolean)
            : ["DATA"];
      }

      if (
        update.rewardValue !==
        undefined
      ) {
        update.rewardValue =
          Math.max(
            0,
            Number(
              update.rewardValue
            )
          );
      }

      if (
        update.maxReward !==
        undefined
      ) {
        update.maxReward =
          Math.max(
            0,
            Number(
              update.maxReward
            )
          );
      }

      if (
        update.minTransactionAmount !==
        undefined
      ) {
        update.minTransactionAmount =
          Math.max(
            0,
            Number(
              update.minTransactionAmount
            )
          );
      }

      if (
        update.perUserLimit !==
        undefined
      ) {
        update.perUserLimit =
          Number(
            update.perUserLimit
          ) === 1
            ? 1
            : 0;
      }

      if (
        update.budget !==
        undefined
      ) {
        update.budget =
          Math.max(
            0,
            Number(
              update.budget
            )
          );
      }

      if (
        update.priority !==
        undefined
      ) {
        update.priority =
          Math.min(
            100,
            Math.max(
              0,
              Number(
                update.priority
              )
            )
          );
      }

      if (
        update.startsAt !==
        undefined
      ) {
        update.startsAt =
          update.startsAt
            ? new Date(
                update.startsAt
              )
            : null;
      }

      if (
        update.endsAt !==
        undefined
      ) {
        update.endsAt =
          update.endsAt
            ? new Date(
                update.endsAt
              )
            : null;
      }

      const campaign =
        await Campaign.findByIdAndUpdate(
          req.params.id,

          {
            $set: update,
          },

          {
            new: true,
            runValidators: true,
          }
        ).lean();

      if (!campaign) {
        return res.status(404).json({
          ok: false,
          error:
            "Campaign not found",
        });
      }

      return res.json({
        ok: true,
        campaign,
      });
    } catch (e) {
      return res.status(400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

router.delete(
  "/campaigns/:id",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const campaign =
        await Campaign.findByIdAndDelete(
          req.params.id
        ).lean();

      if (!campaign) {
        return res.status(404).json({
          ok: false,
          error:
            "Campaign not found",
        });
      }

      return res.json({
        ok: true,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ── LOYALTY & AGENT RETENTION ────────────────────────────────

router.get(
  "/loyalty/overview",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const [
        summaryRows,
        levelRows,
        agentRows,
      ] = await Promise.all([
        User.aggregate([
          {
            $match: {
              role: {
                $ne: "ADMIN",
              },
            },
          },

          {
            $group: {
              _id: null,

              users: {
                $sum: 1,
              },

              totalPoints: {
                $sum: {
                  $ifNull: [
                    "$loyaltyPoints",
                    0,
                  ],
                },
              },

              lifetimePoints: {
                $sum: {
                  $ifNull: [
                    "$lifetimePoints",
                    0,
                  ],
                },
              },

              agents: {
                $sum: {
                  $cond: [
                    {
                      $eq: [
                        "$role",
                        "AGENT",
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ]),

        User.aggregate([
          {
            $match: {
              role: {
                $ne: "ADMIN",
              },
            },
          },

          {
            $group: {
              _id: {
                $ifNull: [
                  "$loyaltyLevel",
                  "STARTER",
                ],
              },

              users: {
                $sum: 1,
              },

              points: {
                $sum: {
                  $ifNull: [
                    "$lifetimePoints",
                    0,
                  ],
                },
              },
            },
          },

          {
            $sort: {
              users: -1,
            },
          },
        ]),

        User.find({
          role: "AGENT",
        })
          .select(
            "fullName phone totalVolume totalProfit tier loyaltyPoints lifetimePoints agentRank"
          )
          .sort({
            totalVolume: -1,
          })
          .limit(20)
          .lean(),
      ]);

      const summary =
        summaryRows[0] || {
          users: 0,
          totalPoints: 0,
          lifetimePoints: 0,
          agents: 0,
        };

      const levels =
        LEVELS.map(
          (level) => {
            const row =
              levelRows.find(
                (item) =>
                  item._id ===
                  level.key
              );

            return {
              key: level.key,
              label: level.label,
              icon: level.icon,

              users:
                Number(
                  row?.users || 0
                ),

              points:
                Number(
                  row?.points || 0
                ),

              min: level.min,
            };
          }
        );

      const leaderboard =
        agentRows.map(
          (agent) => {
            const volume =
              Number(
                agent.totalVolume ||
                0
              );

            const rank =
              rankForVolume(
                volume
              );

            return {
              _id: agent._id,

              name:
                agent.fullName ||
                "Agent",

              phone:
                agent.phone,

              volume,

              profit:
                Number(
                  agent.totalProfit ||
                  0
                ),

              tier:
                agent.tier ||
                "USER",

              loyaltyPoints:
                Number(
                  agent.loyaltyPoints ||
                  0
                ),

              lifetimePoints:
                Number(
                  agent.lifetimePoints ||
                  0
                ),

              rank:
                rank.key,

              rankLabel:
                rank.label,

              rankIcon:
                rank.icon,
            };
          }
        );

      const rankSummary =
        AGENT_RANKS.map(
          (rank) => ({
            key: rank.key,
            label: rank.label,
            icon: rank.icon,

            minVolume:
              rank.minVolume,

            agents:
              leaderboard.filter(
                (agent) =>
                  agent.rank ===
                  rank.key
              ).length,
          })
        );

      return res.json({
        ok: true,

        summary: {
          users:
            Number(
              summary.users || 0
            ),

          agents:
            Number(
              summary.agents || 0
            ),

          totalPoints:
            Number(
              summary.totalPoints ||
              0
            ),

          lifetimePoints:
            Number(
              summary.lifetimePoints ||
              0
            ),
        },

        levels,

        agentRanks:
          rankSummary,

        leaderboard,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ── WALLET FUNDING INTELLIGENCE ──────────────────────────────
router.get(
  "/funding/overview",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const [
        summaryRows,
        recent,
        providerRows,
      ] = await Promise.all([
        WalletTx.aggregate([
          {
            $match: {
              type: "FUND",
            },
          },

          {
            $group: {
              _id: {
                provider:
                  "$provider",

                status:
                  "$status",
              },

              count: {
                $sum: 1,
              },

              amount: {
                $sum: "$amount",
              },
            },
          },

          {
            $sort: {
              "_id.provider": 1,
              "_id.status": 1,
            },
          },
        ]),

        WalletTx.find({
          type: "FUND",
        })
          .sort({
            createdAt: -1,
          })
          .limit(30)
          .select(
            "userId provider reference amount status createdAt creditedAt meta"
          )
          .lean(),

        WalletFundingEvent.aggregate([
          {
            $group: {
              _id: "$provider",

              events: {
                $sum: 1,
              },

              lastEventAt: {
                $max: "$createdAt",
              },
            },
          },

          {
            $sort: {
              events: -1,
            },
          },
        ]),
      ]);

      const pending =
        await WalletTx.countDocuments({
          type: "FUND",
          status: "PENDING",
        });

      return res.json({
        ok: true,

        summary:
          summaryRows,

        pending,

        recent,

        providers:
          providerRows,

        activeFundingProvider:
          String(
            process.env
              .NEX_FUNDING_PROVIDER ||
            "KORAPAY"
          ).toUpperCase(),
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ── PROVIDER INTELLIGENCE ────────────────────────────────────

router.get(
  "/providers/health",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const service =
        String(
          req.query.service ||
          ""
        ).toUpperCase();

      const [
        health,
        routing,
      ] = await Promise.all([
        getAllProviderHealth(),

        service
          ? getRoutingSnapshot(
              service
            )
          : null,
      ]);

      return res.json({
        ok: true,
        health,

        capabilities:
          capabilities(),

        routing,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ── GET /api/admin/users ──────────────────────────────────────
router.get(
  "/users",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const {
        role,
        search,
        page = 1,
        limit = 20,
      } = req.query;

      const filter = {};

      if (role) {
        filter.role =
          role.toUpperCase();
      }

      if (search) {
        filter.$or = [
          {
            fullName: {
              $regex: search,
              $options: "i",
            },
          },

          {
            phone: {
              $regex: search,
              $options: "i",
            },
          },
        ];
      }

      const total =
        await User.countDocuments(
          filter
        );

      const users =
        await User.find(filter)
          .select(
            "fullName phone role tier walletBalance createdAt isVerified"
          )
          .sort({
            createdAt: -1,
          })
          .skip(
            (Number(page) - 1) *
              Number(limit)
          )
          .limit(
            Number(limit)
          )
          .lean();

      return res.json({
        ok: true,
        total,
        page: Number(page),
        users,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ── PATCH /api/admin/users/:id/role ──────────────────────────
router.patch(
  "/users/:id/role",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const {
        role,
        tier,
      } = req.body;

      const update = {};

      if (role) {
        update.role =
          role.toUpperCase();
      }

      if (tier) {
        update.tier =
          tier.toUpperCase();
      }

      const user =
        await User.findByIdAndUpdate(
          req.params.id,
          update,
          {
            new: true,
          }
        ).select("-pinHash");

      if (!user) {
        return res.status(404).json({
          ok: false,
          error:
            "User not found",
        });
      }

      return res.json({
        ok: true,

        message:
          `✅ ${user.phone} → ${user.role}${user.tier ? ` (${user.tier})` : ""}`,

        user,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ── PATCH /api/admin/users/:id/wallet ────────────────────────
router.patch(
  "/users/:id/wallet",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const {
        amount,
        type = "CREDIT",
        note = "",
      } = req.body;

      if (
        !amount ||
        isNaN(amount) ||
        Number(amount) <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Valid positive amount required",
        });
      }

      const txType =
        type.toUpperCase() ===
        "DEBIT"
          ? "DEBIT"
          : "CREDIT";

      const delta =
        txType === "DEBIT"
          ? -Math.abs(
              Number(amount)
            )
          : Math.abs(
              Number(amount)
            );

      let user;

      if (
        txType === "DEBIT"
      ) {
        user =
          await User.findOneAndUpdate(
            {
              _id:
                req.params.id,

              walletBalance: {
                $gte:
                  Math.abs(
                    Number(
                      amount
                    )
                  ),
              },
            },

            {
              $inc: {
                walletBalance:
                  delta,
              },
            },

            {
              new: true,
            }
          ).select(
            "fullName phone walletBalance"
          );

        if (!user) {
          const exists =
            await User.findById(
              req.params.id
            ).select(
              "_id walletBalance"
            );

          if (!exists) {
            return res.status(404).json({
              ok: false,
              error:
                "User not found",
            });
          }

          return res.status(400).json({
            ok: false,

            error:
              `Insufficient balance. Current: ₦${exists.walletBalance.toLocaleString()}`,
          });
        }
      } else {
        user =
          await User.findByIdAndUpdate(
            req.params.id,

            {
              $inc: {
                walletBalance:
                  delta,
              },
            },

            {
              new: true,
            }
          ).select(
            "fullName phone walletBalance"
          );

        if (!user) {
          return res.status(404).json({
            ok: false,
            error:
              "User not found",
          });
        }
      }

      const {
        genRef,
      } = require("../utils/ref");

      await WalletTx.create({
        userId: user._id,

        type: txType,

        amount:
          Math.abs(
            Number(amount)
          ),

        reference:
          genRef("ADM"),

        status:
          "SUCCESS",

        provider:
          "ADMIN",

        meta: {
          adjustedBy:
            req.user.sub,

          note:
            note ||
            `Admin ${txType.toLowerCase()} adjustment`,
        },
      });

      return res.json({
        ok: true,

        message:
          `${txType} ₦${Number(amount).toLocaleString()} → ${user.phone}. Balance: ₦${user.walletBalance.toLocaleString()}`,

        walletBalance:
          user.walletBalance,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ── GET /api/admin/pricing ────────────────────────────────────
router.get(
  "/pricing",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const [
        plans,
        rules,
      ] = await Promise.all([
        DataPlan.find({})
          .sort({
            network: 1,
            sellPrice: 1,
          })
          .lean(),

        Pricing.find({})
          .sort({
            serviceType: 1,
            network: 1,
            productCode: 1,
          })
          .lean(),
      ]);

      const ruleMap =
        new Map(
          rules.map(
            (r) => [
              `${r.serviceType}|${r.network || ""}|${r.productCode || ""}`,
              r,
            ]
          )
        );

      const dataItems =
        plans.map(
          (p) => {
            const key =
              `DATA|${String(p.network || "").toUpperCase()}|${p.plan_code || ""}`;

            const r =
              ruleMap.get(key);

            return {
              _id: p._id,

              serviceType:
                "DATA",

              network:
                p.network,

              productCode:
                p.plan_code || "",

              label:
                p.title ||
                p.plan_code ||
                "",

              baseCost:
                Number(
                  r?.baseCost ??
                    p.costPrice ??
                    0
                ),

              isActive:
                p.isActive !==
                  false &&
                r?.isActive !==
                  false,

              prices: {
                USER:
                  Number(
                    r?.prices?.USER ||
                      p.tierPrices?.USER ||
                      p.sellPrice ||
                      0
                  ),

                BASIC:
                  Number(
                    r?.prices?.BASIC ||
                      p.tierPrices?.BASIC ||
                      p.sellPrice ||
                      0
                  ),

                SILVER:
                  Number(
                    r?.prices?.SILVER ||
                      p.tierPrices?.SILVER ||
                      p.sellPrice ||
                      0
                  ),

                GOLD:
                  Number(
                    r?.prices?.GOLD ||
                      p.tierPrices?.GOLD ||
                      p.sellPrice ||
                      0
                  ),

                PLATINUM:
                  Number(
                    r?.prices?.PLATINUM ||
                      p.tierPrices?.PLATINUM ||
                      p.sellPrice ||
                      0
                  ),
              },

              pricingMode:
                r?.pricingMode ||
                "MANUAL",

              marginPercent:
                Number(
                  r?.marginPercent ||
                    0
                ),

              fixedFee:
                Number(
                  r?.fixedFee || 0
                ),

              minProfit:
                Number(
                  r?.minProfit || 0
                ),

              roundingUnit:
                Number(
                  r?.roundingUnit ||
                    1
                ),

              enforceProfitFloor:
                r?.enforceProfitFloor !==
                false,

              pricingRuleId:
                r?._id || null,
            };
          }
        );

      const dataKeys =
        new Set(
          plans.map(
            (p) =>
              `DATA|${String(p.network || "").toUpperCase()}|${p.plan_code || ""}`
          )
        );

      const nonDataItems =
        rules
          .filter(
            (r) =>
              !dataKeys.has(
                `${r.serviceType}|${String(r.network || "").toUpperCase()}|${r.productCode || ""}`
              )
          )
          .filter(
            (r) =>
              r.serviceType !==
              "DATA"
          )
          .map(
            (r) => ({
              _id: r._id,

              serviceType:
                r.serviceType,

              network:
                r.network || "",

              productCode:
                r.productCode || "",

              label:
                `${r.serviceType} ${r.network || ""} ${r.productCode || ""}`.trim(),

              baseCost:
                Number(
                  r.baseCost || 0
                ),

              isActive:
                r.isActive !==
                false,

              prices: {
                USER:
                  Number(
                    r.prices?.USER ||
                      0
                  ),

                BASIC:
                  Number(
                    r.prices?.BASIC ||
                      0
                  ),

                SILVER:
                  Number(
                    r.prices?.SILVER ||
                      0
                  ),

                GOLD:
                  Number(
                    r.prices?.GOLD ||
                      0
                  ),

                PLATINUM:
                  Number(
                    r.prices?.PLATINUM ||
                      0
                  ),
              },

              pricingMode:
                r.pricingMode ||
                "MANUAL",

              marginPercent:
                Number(
                  r.marginPercent ||
                    0
                ),

              fixedFee:
                Number(
                  r.fixedFee || 0
                ),

              minProfit:
                Number(
                  r.minProfit || 0
                ),

              roundingUnit:
                Number(
                  r.roundingUnit ||
                    1
                ),

              enforceProfitFloor:
                r.enforceProfitFloor !==
                false,

              pricingRuleId:
                r._id,
            })
          );

      return res.json({
        ok: true,

        items: [
          ...dataItems,
          ...nonDataItems,
        ],
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ── PUT /api/admin/pricing ────────────────────────────────────
router.put(
  "/pricing",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const {
        id,
        serviceType,
        network = "",
        productCode = "",
        baseCost,
        isActive,
        prices,
        pricingMode = "MANUAL",
        marginPercent = 0,
        fixedFee = 0,
        minProfit = 0,
        roundingUnit = 1,
        enforceProfitFloor = true,
      } = req.body;

      if (!id) {
        return res.status(400).json({
          ok: false,
          error: "id required",
        });
      }

      const mode =
        String(
          pricingMode
        ).toUpperCase() ===
        "COST_PLUS"
          ? "COST_PLUS"
          : "MANUAL";

      const normalizedNetwork =
        String(
          network || ""
        )
          .toUpperCase()
          .trim();

      const normalizedService =
        String(
          serviceType ||
            "DATA"
        )
          .toUpperCase()
          .trim();

      const normalizedProduct =
        String(
          productCode ||
            ""
        ).trim();

      const safePrices = {};

      for (
        const tier of [
          "USER",
          "BASIC",
          "SILVER",
          "GOLD",
          "PLATINUM",
        ]
      ) {
        if (
          prices?.[tier] !==
          undefined
        ) {
          const n =
            Number(
              prices[tier]
            );

          if (
            !Number.isFinite(
              n
            ) ||
            n < 0
          ) {
            return res.status(400).json({
              ok: false,
              error:
                `Invalid ${tier} price`,
            });
          }

          safePrices[tier] =
            n;
        }
      }

      const priceSet =
        Object.fromEntries(
          Object.entries(
            safePrices
          ).map(
            ([tier, value]) => [
              `prices.${tier}`,
              value,
            ]
          )
        );

      const costPlusPriceSet =
        Object.fromEntries(
          [
            "USER",
            "BASIC",
            "SILVER",
            "GOLD",
            "PLATINUM",
          ].map(
            (tier) => [
              `prices.${tier}`,
              0,
            ]
          )
        );

      const cost =
        baseCost ===
        undefined
          ? undefined
          : Number(
              baseCost
            );

      const margin =
        Number(
          marginPercent
        );

      const fee =
        Number(
          fixedFee
        );

      const floor =
        Number(
          minProfit
        );

      const unit =
        Number(
          roundingUnit
        );

      if (
        cost !== undefined &&
        (
          !Number.isFinite(
            cost
          ) ||
          cost < 0
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid base cost",
        });
      }

      if (
        !Number.isFinite(
          margin
        ) ||
        margin < 0 ||
        margin > 100
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Margin must be 0–100%",
        });
      }

      if (
        !Number.isFinite(
          fee
        ) ||
        fee < 0 ||
        !Number.isFinite(
          floor
        ) ||
        floor < 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid fee/minimum profit",
        });
      }

      if (
        !Number.isFinite(
          unit
        ) ||
        unit < 1
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Rounding unit must be at least 1",
        });
      }

      const dataPlan =
        normalizedService ===
        "DATA"
          ? await DataPlan.findById(
              id
            ).lean()
          : null;

      if (dataPlan) {
        const currentPrices = {
          USER:
            Number(
              dataPlan.tierPrices?.USER ||
                dataPlan.sellPrice ||
                0
            ),

          BASIC:
            Number(
              dataPlan.tierPrices?.BASIC ||
                dataPlan.sellPrice ||
                0
            ),

          SILVER:
            Number(
              dataPlan.tierPrices?.SILVER ||
                dataPlan.sellPrice ||
                0
            ),

          GOLD:
            Number(
              dataPlan.tierPrices?.GOLD ||
                dataPlan.sellPrice ||
                0
            ),

          PLATINUM:
            Number(
              dataPlan.tierPrices?.PLATINUM ||
                dataPlan.sellPrice ||
                0
            ),
        };

        const requestedPrices = {
          ...currentPrices,
          ...safePrices,
        };

        const requestedCost =
          cost !== undefined
            ? cost
            : Number(
                dataPlan.costPrice ||
                  0
              );

        if (
          enforceProfitFloor !==
            false &&
          requestedCost > 0
        ) {
          const minimumSell =
            requestedCost +
            floor;

          if (
            mode ===
            "COST_PLUS"
          ) {
            const autoSell =
              Math.ceil(
                (
                  requestedCost +
                  (
                    requestedCost *
                    margin /
                    100
                  ) +
                  fee
                ) /
                  unit
              ) * unit;

            if (
              autoSell <
              minimumSell
            ) {
              return res.status(409).json({
                ok: false,

                error:
                  `Cost-plus price ₦${autoSell.toLocaleString()} is below the protected minimum ₦${minimumSell.toLocaleString()}. Increase the margin or reduce minimum profit.`,

                code:
                  "PROFIT_FLOOR",
              });
            }
          } else {
            const violating =
              Object.entries(
                requestedPrices
              ).find(
                ([, value]) =>
                  Number(
                    value || 0
                  ) > 0 &&
                  Number(value) <
                    minimumSell
              );

            if (violating) {
              return res.status(409).json({
                ok: false,

                error:
                  `${violating[0]} price ₦${Number(violating[1]).toLocaleString()} is below the protected minimum ₦${minimumSell.toLocaleString()}.`,

                code:
                  "PROFIT_FLOOR",
              });
            }
          }
        }

        const planUpdate = {};

        if (
          cost !== undefined
        ) {
          planUpdate.costPrice =
            cost;
        }

        if (
          isActive !== undefined
        ) {
          planUpdate.isActive =
            !!isActive;
        }

        if (
          mode === "MANUAL" &&
          safePrices.USER !==
            undefined
        ) {
          planUpdate.sellPrice =
            safePrices.USER;
        }

        if (
          mode === "MANUAL" &&
          Object.keys(
            safePrices
          ).length
        ) {
          planUpdate.tierPrices = {
            ...(dataPlan.tierPrices ||
              {}),
            ...safePrices,
          };
        }

        const plan =
          await DataPlan.findByIdAndUpdate(
            id,
            planUpdate,
            {
              new: true,
            }
          ).lean();

        await Pricing.findOneAndUpdate(
          {
            serviceType:
              "DATA",

            network:
              String(
                plan.network ||
                  normalizedNetwork
              ).toUpperCase(),

            productCode:
              plan.plan_code ||
              normalizedProduct,
          },

          {
            $set: {
              baseCost:
                cost !== undefined
                  ? cost
                  : Number(
                      plan.costPrice ||
                        0
                    ),

              isActive:
                isActive !==
                undefined
                  ? !!isActive
                  : plan.isActive !==
                    false,

              ...(mode ===
              "COST_PLUS"
                ? costPlusPriceSet
                : priceSet),

              pricingMode:
                mode,

              marginPercent:
                margin,

              fixedFee:
                fee,

              minProfit:
                floor,

              roundingUnit:
                unit,

              enforceProfitFloor:
                !!enforceProfitFloor,
            },
          },

          {
            upsert: true,
            new: true,
            setDefaultsOnInsert:
              true,
          }
        );

        return res.json({
          ok: true,
          item: plan,
        });
      }

      const existing =
        await Pricing.findById(
          id
        );

      if (!existing) {
        return res.status(404).json({
          ok: false,
          error:
            "Pricing rule not found",
        });
      }

      const rule =
        await Pricing.findByIdAndUpdate(
          id,

          {
            $set: {
              ...(serviceType !==
              undefined
                ? {
                    serviceType:
                      normalizedService,
                  }
                : {}),

              network:
                normalizedNetwork,

              productCode:
                normalizedProduct,

              ...(cost !==
              undefined
                ? {
                    baseCost:
                      cost,
                  }
                : {}),

              ...(isActive !==
              undefined
                ? {
                    isActive:
                      !!isActive,
                  }
                : {}),

              ...(mode ===
              "COST_PLUS"
                ? costPlusPriceSet
                : priceSet),

              pricingMode:
                mode,

              marginPercent:
                margin,

              fixedFee:
                fee,

              minProfit:
                floor,

              roundingUnit:
                unit,

              enforceProfitFloor:
                !!enforceProfitFloor,
            },
          },

          {
            new: true,
          }
        ).lean();

      return res.json({
        ok: true,
        item: rule,
      });
    } catch (e) {
      if (
        e?.code === 11000
      ) {
        return res.status(409).json({
          ok: false,
          error:
            "A pricing rule already exists for this service/network/product.",
        });
      }

      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ── DELETE /api/admin/pricing/:id ─────────────────────────────
router.delete(
  "/pricing/:id",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const plan =
        await DataPlan.findById(
          req.params.id
        ).lean();

      if (plan) {
        await Promise.all([
          DataPlan.findByIdAndDelete(
            req.params.id
          ),

          Pricing.deleteOne({
            serviceType:
              "DATA",

            network:
              String(
                plan.network || ""
              ).toUpperCase(),

            productCode:
              plan.plan_code ||
              "",
          }),
        ]);

        return res.json({
          ok: true,
        });
      }

      await Pricing.findByIdAndDelete(
        req.params.id
      );

      return res.json({
        ok: true,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ── GET /api/admin/profit ────────────────────────────────────
router.get(
  "/profit",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const days =
        Math.min(
          Math.max(
            Number(
              req.query.days ||
                30
            ),
            1
          ),
          90
        );

      const start =
        new Date(
          Date.now() -
            days *
              24 *
              60 *
              60 *
              1000
        );

      const match = {
        status: "SUCCESS",

        createdAt: {
          $gte: start,
        },
      };

      const [
        summaryRows,
        serviceRows,
        dailyRows,
        rewardRows,
      ] = await Promise.all([
        Transaction.aggregate([
          {
            $match: match,
          },

          {
            $group: {
              _id: null,

              sales: {
                $sum: {
                  $ifNull: [
                    "$sellPrice",
                    "$amount",
                  ],
                },
              },

              providerCost: {
                $sum: {
                  $ifNull: [
                    "$baseCost",
                    0,
                  ],
                },
              },

              recordedProfit: {
                $sum: {
                  $ifNull: [
                    "$profit",
                    0,
                  ],
                },
              },

              transactions: {
                $sum: 1,
              },

              unknownCost: {
                $sum: {
                  $cond: [
                    {
                      $lte: [
                        {
                          $ifNull: [
                            "$baseCost",
                            0,
                          ],
                        },

                        0,
                      ],
                    },

                    1,

                    0,
                  ],
                },
              },

              lossTransactions: {
                $sum: {
                  $cond: [
                    {
                      $lt: [
                        {
                          $ifNull: [
                            "$profit",
                            0,
                          ],
                        },

                        0,
                      ],
                    },

                    1,

                    0,
                  ],
                },
              },
            },
          },
        ]),

        Transaction.aggregate([
          {
            $match: match,
          },

          {
            $group: {
              _id: "$type",

              sales: {
                $sum: {
                  $ifNull: [
                    "$sellPrice",
                    "$amount",
                  ],
                },
              },

              providerCost: {
                $sum: {
                  $ifNull: [
                    "$baseCost",
                    0,
                  ],
                },
              },

              profit: {
                $sum: {
                  $ifNull: [
                    "$profit",
                    0,
                  ],
                },
              },

              transactions: {
                $sum: 1,
              },

              unknownCost: {
                $sum: {
                  $cond: [
                    {
                      $lte: [
                        {
                          $ifNull: [
                            "$baseCost",
                            0,
                          ],
                        },

                        0,
                      ],
                    },

                    1,

                    0,
                  ],
                },
              },
            },
          },

          {
            $sort: {
              profit: -1,
            },
          },
        ]),

        Transaction.aggregate([
          {
            $match: match,
          },

          {
            $group: {
              _id: {
                $dateToString: {
                  format:
                    "%Y-%m-%d",

                  date:
                    "$createdAt",
                },
              },

              sales: {
                $sum: {
                  $ifNull: [
                    "$sellPrice",
                    "$amount",
                  ],
                },
              },

              profit: {
                $sum: {
                  $ifNull: [
                    "$profit",
                    0,
                  ],
                },
              },

              transactions: {
                $sum: 1,
              },
            },
          },

          {
            $sort: {
              "_id": 1,
            },
          },
        ]),

        WalletTx.aggregate([
          {
            $match: {
              status:
                "SUCCESS",

              type:
                "CREDIT",

              "meta.reward": {
                $in: [
                  "REFERRER_BONUS",
                  "REFEREE_BONUS",
                  "CAMPAIGN_CASHBACK",
                ],
              },

              createdAt: {
                $gte: start,
              },
            },
          },

          {
            $group: {
              _id: null,

              total: {
                $sum:
                  "$amount",
              },

              count: {
                $sum: 1,
              },
            },
          },
        ]),
      ]);

      const s =
        summaryRows[0] || {
          sales: 0,
          providerCost: 0,
          recordedProfit: 0,
          transactions: 0,
          unknownCost: 0,
          lossTransactions: 0,
        };

      const sales =
        Number(
          s.sales || 0
        );

      const profit =
        Number(
          s.recordedProfit ||
            0
        );

      const rewardExpense =
        Number(
          rewardRows[0]?.total ||
            0
        );

      const netProfitAfterRewards =
        profit -
        rewardExpense;

      return res.json({
        ok: true,

        periodDays:
          days,

        summary: {
          sales,

          providerCost:
            Number(
              s.providerCost ||
                0
            ),

          recordedProfit:
            profit,

          rewardExpense,

          netProfitAfterRewards,

          marginPercent:
            sales
              ? Number(
                  (
                    (profit /
                      sales) *
                    100
                  ).toFixed(2)
                )
              : 0,

          netMarginPercent:
            sales
              ? Number(
                  (
                    (
                      netProfitAfterRewards /
                      sales
                    ) *
                    100
                  ).toFixed(2)
                )
              : 0,

          transactions:
            Number(
              s.transactions ||
                0
            ),

          unknownCost:
            Number(
              s.unknownCost ||
                0
            ),

          lossTransactions:
            Number(
              s.lossTransactions ||
                0
            ),

          costCoveragePercent:
            s.transactions
              ? Number(
                  (
                    (
                      (
                        s.transactions -
                        s.unknownCost
                      ) /
                      s.transactions
                    ) *
                    100
                  ).toFixed(1)
                )
              : 0,
        },

        byService:
          serviceRows.map(
            (r) => ({
              serviceType:
                r._id ||
                "OTHER",

              sales:
                Number(
                  r.sales || 0
                ),

              providerCost:
                Number(
                  r.providerCost ||
                    0
                ),

              profit:
                Number(
                  r.profit || 0
                ),

              marginPercent:
                r.sales
                  ? Number(
                      (
                        (
                          r.profit /
                          r.sales
                        ) *
                        100
                      ).toFixed(2)
                    )
                  : 0,

              transactions:
                Number(
                  r.transactions ||
                    0
                ),

              unknownCost:
                Number(
                  r.unknownCost ||
                    0
                ),
            })
          ),

        daily:
          dailyRows.map(
            (r) => ({
              date:
                r._id,

              sales:
                Number(
                  r.sales || 0
                ),

              profit:
                Number(
                  r.profit || 0
                ),

              transactions:
                Number(
                  r.transactions ||
                    0
                ),
            })
          ),
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ── GET /api/admin/pricing-health ────────────────────────────
router.get(
  "/pricing-health",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const days =
        Math.min(
          Math.max(
            Number(
              req.query.days ||
                30
            ),
            1
          ),
          90
        );

      const start =
        new Date(
          Date.now() -
            days *
              24 *
              60 *
              60 *
              1000
        );

      const rows =
        await Transaction.aggregate([
          {
            $match: {
              status:
                "SUCCESS",

              createdAt: {
                $gte: start,
              },
            },
          },

          {
            $group: {
              _id: {
                serviceType:
                  "$type",

                provider:
                  "$provider",
              },

              sales: {
                $sum: {
                  $ifNull: [
                    "$sellPrice",
                    "$amount",
                  ],
                },
              },

              profit: {
                $sum: {
                  $ifNull: [
                    "$profit",
                    0,
                  ],
                },
              },

              transactions: {
                $sum: 1,
              },

              unknownCost: {
                $sum: {
                  $cond: [
                    {
                      $lte: [
                        {
                          $ifNull: [
                            "$baseCost",
                            0,
                          ],
                        },

                        0,
                      ],
                    },

                    1,

                    0,
                  ],
                },
              },

              minProfit: {
                $min: {
                  $ifNull: [
                    "$profit",
                    0,
                  ],
                },
              },
            },
          },

          {
            $sort: {
              profit: -1,
            },
          },
        ]);

      return res.json({
        ok: true,

        days,

        items:
          rows.map(
            (r) => ({
              serviceType:
                r._id
                  ?.serviceType ||
                "OTHER",

              provider:
                r._id?.provider ||
                "UNKNOWN",

              sales:
                Number(
                  r.sales || 0
                ),

              profit:
                Number(
                  r.profit || 0
                ),

              marginPercent:
                r.sales
                  ? Number(
                      (
                        (
                          r.profit /
                          r.sales
                        ) *
                        100
                      ).toFixed(2)
                    )
                  : 0,

              transactions:
                Number(
                  r.transactions ||
                    0
                ),

              unknownCost:
                Number(
                  r.unknownCost ||
                    0
                ),

              minProfit:
                Number(
                  r.minProfit || 0
                ),
            })
          ),
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ── GET /api/admin/manual-tx ─────────────────────────────────
router.get(
  "/manual-tx",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const txs =
        await Transaction.find({
          status:
            "PROCESSING",

          type: {
            $in: [
              "AIRTIME_TO_CASH",
              "EXAM_PIN",
              "EXAM",
            ],
          },
        })
          .sort({
            createdAt: -1,
          })
          .populate(
            "userId",
            "fullName phone walletBalance"
          )
          .lean();

      return res.json({
        ok: true,
        txs,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ── POST /api/admin/manual-tx/:id/approve ─────────────────────
router.post(
  "/manual-tx/:id/approve",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const {
        id,
      } = req.params;

      const {
        note = "",
        pins = [],
      } = req.body;

      const tx =
        await Transaction.findById(
          id
        );

      if (!tx) {
        return res.status(404).json({
          ok: false,
          error:
            "Transaction not found",
        });
      }

      if (
        tx.status !==
        "PROCESSING"
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Transaction already processed",
        });
      }

      tx.status =
        "SUCCESS";

      tx.meta = {
        ...tx.meta,

        adminNote:
          note,

        approvedAt:
          new Date(),
      };

      if (
        pins.length > 0
      ) {
        tx.meta.pins =
          pins;
      }

      await tx.save();

      await recordTransactionEvent(
        tx,
        {
          status:
            "SUCCESS",

          processingStage:
            "COMPLETED",

          message:
            "Transaction approved by NEX support.",

          source:
            "ADMIN",
        }
      );

      await notifyTransactionStatus(
        tx,
        "SUCCESS"
      );

      await applyCampaignReward(
        tx
      ).catch(
        (error) => {
          console.error(
            "[campaign] manual approval reward:",
            error.message
          );
        }
      );

      await awardLoyaltyPoints(
        tx
      ).catch(
        (error) => {
          console.error(
            "[loyalty] manual approval points:",
            error.message
          );
        }
      );

      if (
        tx.type ===
        "AIRTIME_TO_CASH"
      ) {
        const payout =
          tx.amount;

        const user =
          await User.findByIdAndUpdate(
            tx.userId,

            {
              $inc: {
                walletBalance:
                  payout,
              },
            },

            {
              new: true,
            }
          );

        const {
          genRef,
        } = require(
          "../utils/ref"
        );

        await WalletTx.create({
          userId:
            tx.userId,

          type:
            "CREDIT",

          amount:
            payout,

          reference:
            genRef("A2C"),

          status:
            "SUCCESS",

          provider:
            "ADMIN",

          meta: {
            txId:
              tx._id,

            type:
              "A2C_PAYOUT",

            note:
              note ||
              "Airtime to Cash payout",
          },
        });
      }

      return res.json({
        ok: true,

        message:
          "Transaction approved successfully",
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ── POST /api/admin/manual-tx/:id/reject ──────────────────────
router.post(
  "/manual-tx/:id/reject",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const {
        id,
      } = req.params;

      const {
        reason = "",
      } = req.body;

      const tx =
        await Transaction.findById(
          id
        );

      if (!tx) {
        return res.status(404).json({
          ok: false,
          error:
            "Transaction not found",
        });
      }

      if (
        tx.status !==
        "PROCESSING"
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Transaction already processed",
        });
      }

      tx.status =
        "FAILED";

      tx.lastError =
        reason ||
        "Rejected by admin";

      tx.processingStage =
        "FAILED";

      tx.statusMessage =
        "Transaction was rejected by NEX support.";

      await tx.save();

      await recordTransactionEvent(
        tx,
        {
          status:
            "FAILED",

          processingStage:
            "FAILED",

          message:
            tx.statusMessage,

          source:
            "ADMIN",
        }
      );

      if (
        tx.type ===
          "EXAM_PIN" ||
        tx.type ===
          "EXAM"
      ) {
        const refundAmt =
          tx.amount;

        await User.findByIdAndUpdate(
          tx.userId,

          {
            $inc: {
              walletBalance:
                refundAmt,
            },
          }
        );

        const {
          genRef,
        } = require(
          "../utils/ref"
        );

        await WalletTx.create({
          userId:
            tx.userId,

          type:
            "CREDIT",

          amount:
            refundAmt,

          reference:
            genRef("RFD"),

          status:
            "SUCCESS",

          provider:
            "ADMIN",

          meta: {
            txId:
              tx._id,

            reason:
              "Admin rejected request",
          },
        });

        tx.status =
          "REFUNDED";

        tx.processingStage =
          "REFUNDED";

        tx.statusMessage =
          "Transaction was rejected and your wallet was refunded.";

        await tx.save();

        await recordTransactionEvent(
          tx,
          {
            status:
              "REFUNDED",

            processingStage:
              "REFUNDED",

            message:
              tx.statusMessage,

            source:
              "ADMIN",
          }
        );

        await notifyTransactionStatus(
          tx,
          "REFUNDED"
        );
      } else {
        await notifyTransactionStatus(
          tx,
          "FAILED"
        );
      }

      return res.json({
        ok: true,

        message:
          "Transaction rejected/refunded",
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);
// GET /api/admin/funding-status
router.get(
  "/funding-status",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const status =
        await getPeyflexFundingStatus();

      return res.json({
        ok: true,
        data: status,
      });
    } catch (e) {
      console.error(
        "[admin/funding-status]:",
        e
      );

      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);
// POST /api/admin/funding/request
//
// Creates a PENDING request only.
// NO MONEY IS TRANSFERRED.

router.post(
  "/funding/request",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const {
        getPeyflexFundingStatus,
      } = require("../services/peyflex.funding.service");

      const status =
        await getPeyflexFundingStatus();

      if (!status.needsFunding) {
        return res.status(400).json({
          ok: false,
          error:
            "Peyflex balance is above the minimum threshold. Funding is not required.",
          data: status,
        });
      }

      // Prevent duplicate pending requests.
      const existing =
        await ProviderFunding.findOne({
          provider: "PEYFLEX",
          fundingProvider: "KORAPAY",
          status: {
            $in: [
              "PENDING",
              "APPROVED",
              "PROCESSING",
            ],
          },
        }).lean();

      if (existing) {
        return res.status(409).json({
          ok: false,
          error:
            "A Peyflex funding request is already pending or processing.",
          data: existing,
        });
      }

      const reference =
        `NEX-PF-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)
          .toUpperCase()}`;

      const request =
        await ProviderFunding.create({
          reference,

          provider: "PEYFLEX",
          fundingProvider: "KORAPAY",

          amount: status.fundingRequired,

          peyflexBalanceBefore:
            status.currentBalance,

          targetBalance:
            status.targetBalance,

          status: "PENDING",

          narration:
            "NEX Peyflex wallet funding",
        });

      return res.status(201).json({
        ok: true,

        message:
          "Peyflex funding request created. Awaiting admin approval.",

        data: request,
      });
    } catch (e) {
      console.error(
        "[admin/funding/request]",
        e
      );

      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);
// POST /api/admin/funding/:reference/approve
//
// SAFETY:
// This endpoint ONLY changes PENDING → APPROVED.
// It does NOT call Korapay.
// It does NOT move money.

router.post(
  "/funding/:reference/approve",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const { reference } = req.params;
      console.log("========== FUNDING APPROVAL DEBUG ==========");
console.log("Reference:", JSON.stringify(reference));
console.log("DB name:", mongoose.connection.name);
console.log("DB host:", mongoose.connection.host);
console.log("Collection:", ProviderFunding.collection.name);

const allFunding = await ProviderFunding.find({})
  .sort({ createdAt: -1 })
  .limit(5)
  .select("reference status amount")
  .lean();

console.log("Latest funding records:", allFunding);
console.log("============================================");

console.log(
  "[funding/approve] reference received:",
  JSON.stringify(reference)
);

console.log(
  "[funding/approve] database:",
  ProviderFunding.db.name
);

const exists = await ProviderFunding.exists({
  reference,
});

console.log(
  "[funding/approve] exists:",
  exists
);

if (!reference) {        return res.status(400).json({
          ok: false,
          error: "Funding reference is required",
        });
      }

      const funding =
        await ProviderFunding.findOne({
          reference,
        });

      if (!funding) {
        return res.status(404).json({
          ok: false,
          error: "Funding request not found",
        });
      }

      if (funding.status !== "PENDING") {
        return res.status(409).json({
          ok: false,
          error:
            `Funding request cannot be approved from status ${funding.status}`,
          data: funding,
        });
      }

      funding.status = "APPROVED";
      funding.approvedBy = req.user?.sub || null;
      funding.approvedAt = new Date();

      await funding.save();

      return res.json({
        ok: true,
        message:
          "Funding request approved. No money has been transferred.",
        data: funding,
      });
    } catch (e) {
      console.error(
        "[admin/funding/approve]",
        e
      );

      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);
// POST /api/admin/funding/:reference/execute
//
// SAFETY:
// Executes an APPROVED Peyflex funding request.
// The execution service checks:
// - request status
// - duplicate payout
// - Korapay balance
// - verified Peyflex destination
//
// It will NOT execute if Korapay has insufficient funds.

router.post(
  "/funding/:reference/execute",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const { reference } = req.params;

      if (!reference) {
        return res.status(400).json({
          ok: false,
          error: "Funding reference is required",
        });
      }

      const {
        executePeyflexFunding,
      } = require(
        "../services/peyflex.funding.execution.service"
      );

      const result =
        await executePeyflexFunding(reference);

      return res.json(result);
    } catch (e) {
      console.error(
        "[admin/funding/execute]",
        e
      );

      return res.status(400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// POST /api/admin/funding/:reference/reconcile
//
// Read/checks the current Korapay payout status.
// It does NOT initiate a new payout.

router.post(
  "/funding/:reference/reconcile",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const { reference } = req.params;

      if (!reference) {
        return res.status(400).json({
          ok: false,
          error: "Funding reference is required",
        });
      }

      const {
        reconcilePeyflexFunding,
      } = require(
        "../services/peyflex.funding.reconciliation.service"
      );

      const result =
        await reconcilePeyflexFunding(reference);

      return res.json(result);
    } catch (e) {
      console.error(
        "[admin/funding/reconcile]",
        e
      );

      return res.status(400).json({
        ok: false,
        error: e.message,
      });
    }
  }
);
// GET /api/admin/funding/dashboard
//
// READ-ONLY.
// Shows Peyflex balance, Korapay balance,
// funding thresholds and latest funding request.

router.get(
  "/funding/dashboard",
  auth,
  requireAdminRole,
  async (req, res) => {
    try {
      const {
        getPeyflexFundingStatus,
      } = require(
        "../services/peyflex.funding.service"
      );

      const {
        getKorapayBalance,
      } = require(
        "../services/korapay.transfer.service"
      );

      const [
        peyflexStatus,
        korapayResult,
        latestFunding,
      ] = await Promise.all([
        getPeyflexFundingStatus(),
        getKorapayBalance(),
        ProviderFunding.findOne({
          provider: "PEYFLEX",
          fundingProvider: "KORAPAY",
        })
          .sort({ createdAt: -1 })
          .lean(),
      ]);

      const korapayBalance = Number(
        korapayResult?.data?.NGN?.available_balance || 0
      );

      return res.json({
        ok: true,

        data: {
          peyflex: {
            currentBalance:
              Number(
                peyflexStatus.currentBalance
              ),
            minimumBalance:
              Number(
                peyflexStatus.minimumBalance
              ),
            targetBalance:
              Number(
                peyflexStatus.targetBalance
              ),
            fundingRequired:
              Number(
                peyflexStatus.fundingRequired
              ),
            needsFunding:
              Boolean(
                peyflexStatus.needsFunding
              ),
            source:
              peyflexStatus.source,
          },

          korapay: {
            availableBalance:
              korapayBalance,
            currency: "NGN",
          },

          funding: latestFunding || null,

          destination: {
            bank:
              process.env.PEYFLEX_FUNDING_BANK_NAME ||
              "",
            bankCode:
              process.env.PEYFLEX_FUNDING_BANK_CODE ||
              "",
            account:
              process.env.PEYFLEX_FUNDING_ACCOUNT ||
              "",
            accountName:
              process.env.PEYFLEX_FUNDING_ACCOUNT_NAME ||
              "",
          },
        },
      });
    } catch (e) {
      console.error(
        "[admin/funding/dashboard]",
        e
      );

      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);
module.exports = router;