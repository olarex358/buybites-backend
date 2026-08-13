const router = require("express").Router();
const { z } = require("zod");

const DataPlan = require("../models/DataPlan");
const { peyflexClient } = require("../services/peyflex.service");
const { auth } = require("../middleware/auth");

// ─────────────────────────────────────────────────────────────
// ADMIN ACCESS
// ─────────────────────────────────────────────────────────────

function isAdmin(req) {
  if ((req.user?.role || "").toUpperCase() === "ADMIN") {
    return true;
  }

  const key = req.headers["x-admin-key"];

  return (
    key &&
    process.env.ADMIN_KEY &&
    key === process.env.ADMIN_KEY
  );
}

function adminAccess(req, res, next) {
  if (isAdmin(req)) {
    return next();
  }

  return auth(req, res, () => {
    if (isAdmin(req)) {
      return next();
    }

    return res.status(403).json({
      ok: false,
      error: "Admin only",
    });
  });
}

// ─────────────────────────────────────────────────────────────
// PEYFLEX NETWORKS
// ─────────────────────────────────────────────────────────────

const PEYFLEX_NETWORKS = [
  {
    identifier: "mtn_gifting_data",
    displayNetwork: "MTN",
  },
  {
    identifier: "mtn_data_share",
    displayNetwork: "MTN",
  },
  {
    identifier: "glo_data",
    displayNetwork: "GLO",
  },
  {
    identifier: "airtel_data",
    displayNetwork: "AIRTEL",
  },
  {
    identifier: "9mobile_data",
    displayNetwork: "9MOBILE",
  },
];

// ─────────────────────────────────────────────────────────────
// GET /api/plans/:network
// ─────────────────────────────────────────────────────────────

router.get("/:network", async (req, res) => {
  try {
    const network = String(
      req.params.network || ""
    )
      .toUpperCase()
      .trim();

    const plans = await DataPlan.find({
      network,
      isActive: true,
    })
      .sort({ sellPrice: 1 })
      .lean();

    return res.json({
      ok: true,
      plans,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/plans/sync
//
// IMPORTANT:
// This sync ONLY updates provider information.
//
// Peyflex amount → costPrice
//
// It DOES NOT update sellPrice.
//
// Existing customer selling prices remain untouched.
// ─────────────────────────────────────────────────────────────

router.post(
  "/sync",
  adminAccess,
  async (req, res) => {
    if (!isAdmin(req)) {
      return res.status(403).json({
        ok: false,
        error: "Admin only",
      });
    }

    try {
      const api = peyflexClient();

      const results = [];

      let totalFetched = 0;
      let totalUpdated = 0;
      let totalMissing = 0;

      const missing = [];

      for (const {
        identifier,
        displayNetwork,
      } of PEYFLEX_NETWORKS) {
        try {
          console.log(
            `\n📡 Fetching Peyflex plans: ${identifier}`
          );

          const r = await api.get(
            "/api/data/plans/",
            {
              params: {
                network: identifier,
              },
            }
          );

          const raw = r.data;

          const list = Array.isArray(raw)
            ? raw
            : Array.isArray(raw?.plans)
            ? raw.plans
            : Array.isArray(raw?.results)
            ? raw.results
            : Array.isArray(raw?.data)
            ? raw.data
            : [];

          totalFetched += list.length;

          console.log(
            `   Found ${list.length} plans`
          );

          let updated = 0;
          let notFound = 0;

          for (const item of list) {
            // Peyflex returns:
            // plan_code
            // amount
            // label

            const plan_code = String(
              item.plan_code ||
                item.code ||
                item.id ||
                ""
            ).trim();

            const title = String(
              item.label ||
                item.name ||
                item.title ||
                item.description ||
                plan_code
            ).trim();

            const providerCost = Number(
              item.amount
            );

            if (
              !plan_code ||
              !Number.isFinite(providerCost) ||
              providerCost < 0
            ) {
              continue;
            }

            // ─────────────────────────────────────────────
            // IMPORTANT
            //
            // Match by:
            // network
            // + plan_code
            // + peyflexNetwork
            //
            // This prevents:
            //
            // MTN Gifting M1GBS
            //
            // from being confused with:
            //
            // MTN Data Share M1GBS
            // ─────────────────────────────────────────────

            const existing =
              await DataPlan.findOne({
                network: displayNetwork,
                plan_code,
                peyflexNetwork:
                  identifier,
              });

            if (!existing) {
              totalMissing++;
              notFound++;

              missing.push({
                network: displayNetwork,
                peyflexNetwork: identifier,
                plan_code,
                providerCost,
              });

              continue;
            }

            // ─────────────────────────────────────────────
            // ONLY UPDATE PROVIDER INFORMATION
            // ─────────────────────────────────────────────

            existing.costPrice =
              providerCost;

            existing.provider =
              "PEYFLEX";

            existing.peyflexNetwork =
              identifier;

            // IMPORTANT:
            //
            // existing.sellPrice is NOT changed.
            //
            // existing.tierPrices are NOT changed.
            //
            // existing.title is NOT changed.
            // ─────────────────────────────────────────────

            await existing.save();

            updated++;
            totalUpdated++;

            console.log(
              `   ✅ ${displayNetwork} | ${plan_code} | Cost ₦${providerCost} | Sell ₦${existing.sellPrice}`
            );
          }

          results.push({
            identifier,
            network: displayNetwork,
            fetched: list.length,
            updated,
            missing: notFound,
          });
        } catch (e) {
          console.error(
            `[plans/sync] ${identifier}:`,
            e?.response?.data ||
              e.message
          );

          results.push({
            identifier,
            network: displayNetwork,
            fetched: 0,
            updated: 0,
            missing: 0,
            error:
              e?.response?.data ||
              e.message,
          });
        }
      }

      return res.json({
        ok: true,

        totalFetched,

        totalUpdated,

        totalMissing,

        results,

        missing,

        message:
          `Peyflex sync completed. ` +
          `${totalUpdated} provider costs updated. ` +
          `${totalMissing} local plans not found.`,

      });
    } catch (e) {
      console.error(
        "[plans/sync]",
        e
      );

      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// POST /api/plans
// Manually add a single plan
// ─────────────────────────────────────────────────────────────

router.post(
  "/",
  adminAccess,
  async (req, res, next) => {
    try {
      if (!isAdmin(req)) {
        return res.status(403).json({
          ok: false,
          error: "Admin only",
        });
      }

      const b = z
        .object({
          network: z.string().min(2),
          plan_code: z.string().min(2),
          title: z.string().optional(),
          sellPrice: z.number().min(1),
          costPrice: z.number().optional(),
          isActive: z.boolean().optional(),
        })
        .parse(req.body);

      const plan =
        await DataPlan.findOneAndUpdate(
          {
            network: b.network,
            plan_code: b.plan_code,
          },
          {
            network: b.network,
            plan_code: b.plan_code,
            title: b.title || "",
            sellPrice: b.sellPrice,
            costPrice:
              b.costPrice || 0,
            isActive:
              b.isActive ?? true,
          },
          {
            upsert: true,
            new: true,
          }
        );

      return res.json({
        ok: true,
        plan,
      });
    } catch (e) {
      next(e);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// DELETE /api/plans/:id
// Deactivate a plan
// ─────────────────────────────────────────────────────────────

router.delete(
  "/:id",
  adminAccess,
  async (req, res) => {
    if (!isAdmin(req)) {
      return res.status(403).json({
        ok: false,
        error: "Admin only",
      });
    }

    await DataPlan.findByIdAndUpdate(
      req.params.id,
      {
        isActive: false,
      }
    );

    return res.json({
      ok: true,
    });
  }
);

// ─────────────────────────────────────────────────────────────
// POST /api/plans/markup
//
// Applies markup to sellPrice.
//
// NOTE:
// This is still manual/admin-controlled.
// ─────────────────────────────────────────────────────────────

router.post(
  "/markup",
  adminAccess,
  async (req, res) => {
    if (!isAdmin(req)) {
      return res.status(403).json({
        ok: false,
        error: "Admin only",
      });
    }

    try {
      const {
        markupPercent = 5,
        network,
        maxAmount = 200000,
      } = req.body;

      if (
        markupPercent <= 0 ||
        markupPercent > 100
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "markupPercent must be 1–100",
        });
      }

      const filter = {
        isActive: true,
      };

      if (network) {
        filter.network = String(
          network
        )
          .toUpperCase()
          .trim();
      }

      const plans =
        await DataPlan.find(
          filter
        ).lean();

      let updated = 0;
      let skipped = 0;

      for (const plan of plans) {
        const base =
          Number(
            plan.costPrice || 0
          );

        if (
          maxAmount &&
          base > maxAmount
        ) {
          skipped++;
          continue;
        }

        const baseCost =
          base > 0
            ? base
            : Number(
                plan.sellPrice || 0
              );

        if (!baseCost) {
          skipped++;
          continue;
        }

        const raw =
          baseCost *
          (1 + markupPercent / 100);

        const sellPrice =
          Math.ceil(raw / 5) * 5;

        await DataPlan.findByIdAndUpdate(
          plan._id,
          {
            sellPrice,
          }
        );

        updated++;
      }

      return res.json({
        ok: true,
        updated,
        skipped,
        markupPercent,
        network:
          network || "ALL",
        message:
          `✅ ${updated} plans updated with ${markupPercent}% markup`,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// CLEAN PLAN TITLES
// ─────────────────────────────────────────────────────────────

function cleanPlanTitle(
  raw = ""
) {
  return raw
    .replace(
      /\s*=\s*[N₦][\d,]+(\.\d+)?\s*/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

// POST /api/plans/clean-titles

router.post(
  "/clean-titles",
  adminAccess,
  async (req, res) => {
    if (!isAdmin(req)) {
      return res.status(403).json({
        ok: false,
        error: "Admin only",
      });
    }

    try {
      const plans =
        await DataPlan.find(
          {}
        ).lean();

      let updated = 0;

      for (const plan of plans) {
        const cleaned =
          cleanPlanTitle(
            plan.title || ""
          );

        if (
          cleaned !== plan.title
        ) {
          await DataPlan.findByIdAndUpdate(
            plan._id,
            {
              title: cleaned,
            }
          );

          updated++;
        }
      }

      return res.json({
        ok: true,
        updated,
        message:
          `✅ ${updated} plan titles cleaned`,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// SME DATA
// ─────────────────────────────────────────────────────────────

const {
  getDataPlans: smeGetPlans,
} = require(
  "../services/providers/smedata.provider"
);

const SMEDATA_NETWORKS = [
  {
    id: "mtn",
    displayNetwork: "MTN",
  },
  {
    id: "glo",
    displayNetwork: "GLO",
  },
  {
    id: "airtel",
    displayNetwork: "AIRTEL",
  },
  {
    id: "9mobile",
    displayNetwork: "9MOBILE",
  },
];

// ─────────────────────────────────────────────────────────────
// POST /api/plans/smedata-sync
// ─────────────────────────────────────────────────────────────

router.post(
  "/smedata-sync",
  adminAccess,
  async (req, res) => {
    if (!isAdmin(req)) {
      return res.status(403).json({
        ok: false,
        error: "Admin only",
      });
    }

    if (
      !process.env.SMEDATA_TOKEN
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "SMEDATA_TOKEN not set in .env. Register at smedata.ng first.",
      });
    }

    const results = [];
    let totalSynced = 0;

    for (const {
      id,
      displayNetwork,
    } of SMEDATA_NETWORKS) {
      try {
        const r =
          await smeGetPlans({
            network: id,
          });

        const list = Array.isArray(r)
          ? r
          : Array.isArray(r?.data)
          ? r.data
          : Array.isArray(r?.plans)
          ? r.plans
          : [];

        let synced = 0;

        for (const item of list) {
          const plan_code =
            String(
              item.id ||
                item.plan_id ||
                ""
            ).trim();

          const title =
            String(
              item.plan ||
                item.description ||
                plan_code
            ).trim();

          const costPrice =
            Number(
              item.amount ||
                item.price ||
                0
            );

          const sellPrice =
            Math.ceil(
              (costPrice * 1.05) / 5
            ) * 5;

          if (
            !plan_code ||
            !costPrice
          ) {
            continue;
          }

          await DataPlan.findOneAndUpdate(
            {
              network:
                displayNetwork,
              plan_code:
                `SME_${plan_code}`,
            },
            {
              network:
                displayNetwork,

              plan_code:
                `SME_${plan_code}`,

              title:
                title
                  .replace(
                    /\s*=\s*[N₦][\d,]+(\.\d+)?\s*/gi,
                    " "
                  )
                  .trim(),

              sellPrice,

              costPrice,

              isActive: true,

              peyflexNetwork:
                id,

              provider:
                "SMEDATA",
            },
            {
              upsert: true,
              new: true,
            }
          );

          synced++;
        }

        results.push({
          network:
            displayNetwork,
          synced,
        });

        totalSynced += synced;
      } catch (e) {
        results.push({
          network:
            displayNetwork,
          synced: 0,
          error:
            e?.response?.data ||
            e.message,
        });
      }
    }

    return res.json({
      ok: true,
      totalSynced,
      results,
    });
  }
);

// ─────────────────────────────────────────────────────────────
// AIRTIME TO CASH RATES
// ─────────────────────────────────────────────────────────────

router.get(
  "/airtime-to-cash/rates",
  (req, res) => {
    const rates = [
      {
        id: "MTN",
        label: "MTN",
        color: "#FFCC00",
        text: "#333",
        rate:
          Number(
            process.env.A2C_MTN_RATE
          ) || 0.80,
      },

      {
        id: "AIRTEL",
        label: "Airtel",
        color: "#e40000",
        text: "#fff",
        rate:
          Number(
            process.env.A2C_AIRTEL_RATE
          ) || 0.75,
      },

      {
        id: "GLO",
        label: "Glo",
        color: "#007a3d",
        text: "#fff",
        rate:
          Number(
            process.env.A2C_GLO_RATE
          ) || 0.75,
      },

      {
        id: "9MOBILE",
        label: "9mobile",
        color: "#006633",
        text: "#fff",
        rate:
          Number(
            process.env.A2C_9MOBILE_RATE
          ) || 0.70,
      },
    ];

    return res.json({
      ok: true,
      rates,
      sendTo:
        process.env.A2C_SEND_TO ||
        null,
    });
  }
);

// ─────────────────────────────────────────────────────────────

module.exports = router;