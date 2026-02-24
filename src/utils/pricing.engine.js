const Pricing = require("../models/Pricing");

/**
 * Central pricing resolver (single source of truth).
 * - Checks Pricing overrides for tier
 * - Falls back to defaults from plan/provider
 */
async function priceForTier({
  serviceType,
  tier,
  network = "",
  productCode = "",
  defaultSellPrice = 0,
  defaultBaseCost = 0,
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
  });

  // Sell price = what we charge user (wallet debit)
  const sellPrice =
    Number(pricing?.prices?.[t]) ||
    Number(pricing?.prices?.USER) ||
    Number(defaultSellPrice) ||
    0;

  const baseCost = Number(pricing?.baseCost || defaultBaseCost || 0);
  const profit = Math.max(0, sellPrice - baseCost);

  return { sellPrice, baseCost, profit, pricingFound: !!pricing };
}

module.exports = { priceForTier };
