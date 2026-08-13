const crypto = require("crypto");
const router = require("express").Router();
const WalletTx = require("../models/WalletTx");
const User = require("../models/User");
const { notify } = require("../services/notification.service");

const SECRET = process.env.KORAPAY_WEBHOOK_SECRET || process.env.KORAPAY_SECRET_KEY;

function validSignature(data, signature) {
  if (!SECRET || !signature) return false;
  const expected = crypto.createHmac("sha256", SECRET).update(JSON.stringify(data || {})).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post("/", async (req, res) => {
  try {
    const body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString("utf8")) : req.body;

    if (!body?.data || !validSignature(body.data, req.headers["x-korapay-signature"])) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    if (!["transfer.success", "transfer.failed"].includes(body.event)) {
      return res.status(200).json({ received: true });
    }

    const reference = body.data.reference;
    if (!reference) return res.status(200).json({ received: true });

    const walletTx = await WalletTx.findOne({
      reference,
      type: "DEBIT",
      provider: "KORAPAY",
    });

    if (!walletTx) return res.status(200).json({ received: true });

    const status = String(body.data.status || "").toLowerCase();

    if (status === "success" && walletTx.status === "PENDING") {
      walletTx.status = "SUCCESS";
      walletTx.providerReference = reference;
      walletTx.meta = {
        ...(walletTx.meta || {}),
        providerStatus: "SUCCESS",
        providerFee: Number(body.data.fee || 0),
        completedAt: new Date(),
      };
      await walletTx.save();

      await notify({
        userId: walletTx.userId,
        type: "TRANSFER_SUCCESS",
        title: "Bank transfer successful",
        message: `₦${Number(walletTx.amount).toLocaleString()} was sent successfully.`,
        dedupeKey: `transfer-success:${reference}`,
      });
    }

    if (status === "failed" && walletTx.status === "PENDING") {
      walletTx.status = "FAILED";
      walletTx.meta = {
        ...(walletTx.meta || {}),
        providerStatus: "FAILED",
        providerError: body.data.message || "Korapay marked the transfer as failed.",
        failedAt: new Date(),
      };
      await walletTx.save();

      if (!walletTx.meta.refundedAt) {
        await User.findByIdAndUpdate(walletTx.userId, {
          $inc: { walletBalance: Number(walletTx.amount) },
        });

        walletTx.meta.refundedAt = new Date();
        await walletTx.save();

        await notify({
          userId: walletTx.userId,
          type: "TRANSFER_REFUNDED",
          title: "Transfer failed — wallet refunded",
          message: `₦${Number(walletTx.amount).toLocaleString()} has been returned to your NEX wallet.`,
          dedupeKey: `transfer-refund:${reference}`,
        });
      }
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error("[korapay transfer webhook]", e.message);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
});

module.exports = router;
