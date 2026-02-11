const mongoose = require("mongoose");

const ComplaintSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: false },
        phone: { type: String, default: "" },
        category: { type: String, default: "general" }, // payment, delivery, wallet, general
        subject: { type: String, default: "" },
        message: { type: String, required: true },

        status: { type: String, enum: ["OPEN", "IN_PROGRESS", "RESOLVED"], default: "OPEN" },
        priority: { type: String, enum: ["LOW", "MEDIUM", "HIGH"], default: "MEDIUM" },

        adminReply: { type: String, default: "" },
        resolvedAt: { type: Date, default: null }
    },
    { timestamps: true }
);

ComplaintSchema.index({ status: 1, updatedAt: -1 });

module.exports = mongoose.model("Complaint", ComplaintSchema);
