const mongoose = require("mongoose");

const ProviderHealthSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true, uppercase: true, index: true },
    service: { type: String, required: true, uppercase: true, index: true },

    total: { type: Number, default: 0 },
    successes: { type: Number, default: 0 },
    failures: { type: Number, default: 0 },
    unknowns: { type: Number, default: 0 },

    latencyTotalMs: { type: Number, default: 0 },
    lastLatencyMs: { type: Number, default: null },
    averageLatencyMs: { type: Number, default: 0 },

    consecutiveFailures: { type: Number, default: 0 },
    circuitOpenUntil: { type: Date, default: null },
    lastOutcome: {
      type: String,
      enum: ["SUCCESS", "FAILURE", "UNKNOWN", ""],
      default: "",
    },

    lastSuccessAt: { type: Date, default: null },
    lastFailureAt: { type: Date, default: null },
    lastUnknownAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },

    windowStartedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

ProviderHealthSchema.index({ provider: 1, service: 1 }, { unique: true });

module.exports = mongoose.model("ProviderHealth", ProviderHealthSchema);
