const mongoose = require("mongoose");

const AdvertSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, default: "", trim: true, maxlength: 220 },
    imageUrl: { type: String, default: "", trim: true, maxlength: 1000 },
    ctaText: { type: String, default: "Learn More", trim: true, maxlength: 30 },
    ctaUrl: { type: String, default: "", trim: true, maxlength: 500 },

    audience: {
      type: String,
      enum: ["ALL", "USER", "AGENT", "ADMIN"],
      default: "ALL",
      index: true,
    },

    priority: { type: Number, default: 0, min: 0, max: 100 },
    isActive: { type: Boolean, default: true, index: true },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },

    views: { type: Number, default: 0, min: 0 },
    clicks: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

AdvertSchema.index({ isActive: 1, audience: 1, priority: -1, startsAt: 1 });

module.exports = mongoose.model("Advert", AdvertSchema);
