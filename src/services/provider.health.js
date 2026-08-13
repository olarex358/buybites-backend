const ProviderHealth = require("../models/ProviderHealth");

const DEFAULT_SCORE = 50;
const FAILURE_THRESHOLD = Math.max(1, Number(process.env.NEX_PROVIDER_FAILURE_THRESHOLD || 3));
const CIRCUIT_COOLDOWN_MS = Math.max(
  30 * 1000,
  Number(process.env.NEX_PROVIDER_CIRCUIT_COOLDOWN_MS || 5 * 60 * 1000)
);

function normalize(value) {
  return String(value || "").toUpperCase().trim();
}

function isCircuitOpen(row, now = new Date()) {
  return !!(row?.circuitOpenUntil && new Date(row.circuitOpenUntil) > now);
}

function scoreHealth(row) {
  if (!row || !row.total) return DEFAULT_SCORE;

  const successRate = Number(row.successes || 0) / Number(row.total || 1);
  const unknownRate = Number(row.unknowns || 0) / Number(row.total || 1);

  let score = successRate * 75;
  score -= unknownRate * 15;

  if (row.averageLatencyMs > 0) {
    if (row.averageLatencyMs <= 1000) score += 10;
    else if (row.averageLatencyMs <= 3000) score += 7;
    else if (row.averageLatencyMs <= 7000) score += 3;
    else score -= 5;
  }

  const confidence = Math.min(1, Number(row.total || 0) / 30);
  score = DEFAULT_SCORE * (1 - confidence) + score * confidence;

  if (isCircuitOpen(row)) score -= 25;

  return Math.max(0, Math.min(100, Math.round(score * 100) / 100));
}

function stateFor(row) {
  if (!row || !row.total) return "NO_DATA";
  if (isCircuitOpen(row)) return "CIRCUIT_OPEN";

  const successRate = Number(row.successes || 0) / Number(row.total || 1);

  if (Number(row.total || 0) < 5) return "LOW_SAMPLE";
  if (successRate >= 0.95) return "HEALTHY";
  if (successRate >= 0.80) return "DEGRADED";
  return "UNHEALTHY";
}

async function recordProviderAttempt({
  provider,
  service,
  outcome,
  latencyMs = null,
}) {
  const p = normalize(provider);
  const s = normalize(service);
  const result = String(outcome || "").toUpperCase();

  if (!p || !s || !["SUCCESS", "FAILURE", "UNKNOWN"].includes(result)) {
    return null;
  }

  const now = new Date();
  const inc = { total: 1 };
  const set = {
    lastAttemptAt: now,
    lastOutcome: result,
  };

  if (result === "SUCCESS") {
    inc.successes = 1;
    set.lastSuccessAt = now;
    set.consecutiveFailures = 0;
    set.circuitOpenUntil = null;
  } else if (result === "UNKNOWN") {
    inc.unknowns = 1;
    set.lastUnknownAt = now;
  } else {
    inc.failures = 1;
    set.lastFailureAt = now;
  }

  if (Number.isFinite(Number(latencyMs)) && Number(latencyMs) >= 0) {
    inc.latencyTotalMs = Number(latencyMs);
    set.lastLatencyMs = Number(latencyMs);
  }

  const row = await ProviderHealth.findOneAndUpdate(
    { provider: p, service: s },
    { $inc: inc, $set: set, $setOnInsert: { windowStartedAt: now } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  if (result === "FAILURE") {
    // Count consecutive failures separately. A successful attempt resets this
    // counter through the update above.
    const updated = await ProviderHealth.findOneAndUpdate(
      { _id: row._id },
      { $inc: { consecutiveFailures: 1 } },
      { new: true }
    );

    if (Number(updated?.consecutiveFailures || 0) >= FAILURE_THRESHOLD) {
      updated.circuitOpenUntil = new Date(Date.now() + CIRCUIT_COOLDOWN_MS);
      await updated.save();
    }
  }

  const total = Number(row.total || 0);
  if (Number.isFinite(Number(latencyMs)) && total > 0) {
    row.averageLatencyMs = Math.round(Number(row.latencyTotalMs || 0) / total);
    await row.save();
  }

  return row;
}

function serialize(row) {
  if (!row) return null;

  const total = Number(row.total || 0);
  const successRate = total ? Number(row.successes || 0) / total : null;
  const confidence = Math.min(1, total / 30);

  return {
    ...row,
    total,
    successes: Number(row.successes || 0),
    failures: Number(row.failures || 0),
    unknowns: Number(row.unknowns || 0),
    consecutiveFailures: Number(row.consecutiveFailures || 0),
    successRate: successRate === null ? null : Math.round(successRate * 10000) / 100,
    score: scoreHealth(row),
    confidence: Math.round(confidence * 100),
    circuitOpen: isCircuitOpen(row),
    state: stateFor(row),
  };
}

async function getProviderHealth({ provider, service }) {
  const row = await ProviderHealth.findOne({
    provider: normalize(provider),
    service: normalize(service),
  }).lean();

  if (!row) {
    return {
      provider: normalize(provider),
      service: normalize(service),
      total: 0,
      successes: 0,
      failures: 0,
      unknowns: 0,
      consecutiveFailures: 0,
      successRate: null,
      averageLatencyMs: null,
      score: DEFAULT_SCORE,
      confidence: 0,
      circuitOpen: false,
      state: "NO_DATA",
    };
  }

  return serialize(row);
}

async function getAllProviderHealth() {
  const rows = await ProviderHealth.find({}).sort({ service: 1, provider: 1 }).lean();
  return rows.map(serialize);
}

async function recommendProvider({ service, providers = [] }) {
  const names = providers.map(normalize).filter(Boolean);
  if (!names.length) return null;

  const rows = await Promise.all(
    names.map((provider) => getProviderHealth({ provider, service }))
  );

  const available = rows.filter((row) => !row.circuitOpen);

  const pool = available.length ? available : rows;

  pool.sort((a, b) => {
    if (a.state === "NO_DATA" && b.state !== "NO_DATA") return 1;
    if (b.state === "NO_DATA" && a.state !== "NO_DATA") return -1;
    if (a.circuitOpen !== b.circuitOpen) return a.circuitOpen ? 1 : -1;
    return b.score - a.score;
  });

  return pool[0] || null;
}

module.exports = {
  recordProviderAttempt,
  getProviderHealth,
  getAllProviderHealth,
  recommendProvider,
  scoreHealth,
  isCircuitOpen,
  FAILURE_THRESHOLD,
  CIRCUIT_COOLDOWN_MS,
};
