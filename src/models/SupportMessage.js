const mongoose = require("mongoose");

const SupportMessageSchema = new mongoose.Schema(
  {
    ticketId: { type: mongoose.Schema.Types.ObjectId, ref: "Complaint", required: true },
    sender: { type: String, enum: ["USER", "ADMIN"], required: true },
    message: { type: String, required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model("SupportMessage", SupportMessageSchema);
