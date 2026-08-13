const Pricing = require("../models/Pricing");

const TIERS = ["USER", "BASIC", "SILVER", "GOLD", "PLATINUM"];

function roundUp(value, unit = 1) {
  const n = Number(value || 0);
  const u = Math.max(1, Number(unit || 1));
  return Math.ceil(n / u) * u;
}

/**
 * Central pricing resolver.
 *
 * Priority:
 *  1. Active Pricing rule for this service/network/product.
 *  2. Default tier prices supplied by the product (e.g. DataPlan).
 *  3. Default USER sell price.
 *
 * COST_PLUS only calculates a price when a real positive baseCost exists.
 * Profit is never silently clamped to zero: the recorded profit is the
 * actual sellPrice - baseCost.
 */
async function priceForTier({
  serviceType,
  tier,
  network = "",
  productCode = "",
  defaultSellPrice = 0,
  defaultBaseCost = 0,
  defaultTierPrices = {},
}) {
  const svc = String(serviceType || "").toUpperCase().trim();
  const t = String(tier || "USER").toUpperCase().trim();
  const net = String(network || "").toUpperCase().trim();
  const prod = String(productCode || "").trim();

  const pricing = await Pricing.findOne({
    serviceType: svc,
    network: net,
    productCode: prod,
    isActive: true,
  }).lean();

  const baseCost = Number(
    pricing?.baseCost ?? defaultBaseCost ?? 0
  );

  const mode = String(pricing?.pricingMode || "MANUAL").toUpperCase();
  const marginPercent = Math.max(0, Number(pricing?.marginPercent || 0));
  const fixedFee = Math.max(0, Number(pricing?.fixedFee || 0));
  const minProfit = Math.max(0, Number(pricing?.minProfit || 0));
  const roundingUnit = Math.max(1, Number(pricing?.roundingUnit || 1));

  const explicitPrice = Number(pricing?.prices?.[t] || 0);
  const defaultTierPrice = Number(defaultTierPrices?.[t] || 0);

  let sellPrice;
  let pricingSource;

  // In COST_PLUS mode, missing explicit tier prices intentionally fall back
  // to the cost-plus formula instead of inheriting an old product price.
  if (pricing && mode === "COST_PLUS" && baseCost > 0 && !explicitPrice) {
    sellPrice = roundUp(
      baseCost + (baseCost * marginPercent / 100) + fixedFee,
      roundingUnit
    );
    pricingSource = "COST_PLUS";
  } else {
    sellPrice = explicitPrice || defaultTierPrice || Number(defaultSellPrice || 0);
    pricingSource = explicitPrice
      ? "PRICING_RULE"
      : defaultTierPrice
        ? "PRODUCT_TIER"
        : "PRODUCT_DEFAULT";
  }

  if (!Number.isFinite(sellPrice) || sellPrice <= 0) {
    const err = new Error("No valid selling price is configured for this service.");
    err.status = 409;
    throw err;
  }

  const profit = sellPrice - baseCost;
  const floor = baseCost + minProfit;

  const enforceNonLoss = process.env.NEX_ENFORCE_NONLOSS !== "false";

  if (
    (
      (pricing && pricing.enforceProfitFloor !== false) ||
      (!pricing && enforceNonLoss)
    ) &&
    baseCost > 0 &&
    sellPrice < floor
  ) {
    const err = new Error(
      `Pricing would fall below the protected profit floor. Minimum selling price: ₦${floor.toLocaleString()}`
    );
    err.status = 409;
    err.code = "PROFIT_FLOOR";
    err.details = {
      serviceType: svc,
      network: net,
      productCode: prod,
      tier: t,
      sellPrice,
      baseCost,
      minProfit,
      minimumSellPrice: floor,
    };
    throw err;
  }

  return {
    sellPrice,
    baseCost,
    profit,
    marginPercent: sellPrice > 0 ? (profit / sellPrice) * 100 : 0,
    pricingFound: !!pricing,
    pricingSource,
    pricingMode: mode,
    minProfit,
  };
}

module.exports = { priceForTier, TIERS };
