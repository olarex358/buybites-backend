const router = require("express").Router();
const crypto = require("crypto");

const WalletTx = require("../models/WalletTx");
const WalletFundingEvent = require("../models/WalletFundingEvent");
const { creditWalletFromPayment } = require("../services/wallet.credit.service");
const { verifyCheckout } = require("../services/payment.providers");

// server.js mounts this route with express.raw({ type: "application/json" }).
router.post("/", async (req, res) => {
  try {
    const signature = req.headers["x-paystack-signature"];
    const secret = process.env.PAYSTACK_WEBHOOK_SECRET || process.env.PAYSTACK_SECRET_KEY;

    if (!secret || !signature) return res.sendStatus(401);

    const hash = crypto
      .createHmac("sha512", secret)
      .update(req.body)
      .digest("hex");

    if (hash !== signature) return res.sendStatus(401);

    const event = JSON.parse(req.body.toString("utf8"));
    if (event.event !== "charge.success") return res.sendStatus(200);

    const data = event.data || {};
    const ref = data.reference;
    if (!ref) return res.sendStatus(200);

    const tx = await WalletTx.findOne({
      reference: ref,
      type: "FUND",
      provider: "PAYSTACK",
    });

    if (!tx) return res.sendStatus(200);

    await WalletFundingEvent.create({
      userId: tx.userId,
      walletTxId: tx._id,
      provider: "PAYSTACK",
      event: "CHARGE_SUCCESS",
      reference: ref,
      amount: Number(data.amount || 0) / 100,
      status: String(data.status || "success").toUpperCase(),
      source: "WEBHOOK",
      meta: { paystackId: data.id, channel: data.channel, paidAt: data.paid_at },
    }).catch((e) => console.error("[paystack webhook] audit event:", e.message));

    // Never trust the webhook amount/user metadata for wallet credit.
    // Re-query Paystack and credit the internally recorded funding amount.
    let verified;
    try {
      verified = await verifyCheckout("PAYSTACK", ref);
    } catch (error) {
      console.error("[paystack webhook] verification failed:", error.message);
      return res.sendStatus(500);
    }

    if (verified.status !== "SUCCESS") return res.sendStatus(200);

    await creditWalletFromPayment({
      userId: tx.userId,
      reference: ref,
      amount: Number(tx.amount),
      provider: "PAYSTACK",
      meta: {
        ...(tx.meta || {}),
        paystackId: data.id,
        providerReference: verified.providerReference,
        channel: data.channel,
        verifiedVia: "webhook",
      },
      title: "Wallet funding confirmed",
      message: `₦${Number(tx.amount).toLocaleString()} has been confirmed and added to your NEX wallet.`,
    });

    return res.sendStatus(200);
  } catch (error) {
    console.error("[paystack webhook] Error:", error.message);
    return res.sendStatus(500);
  }
});

module.exports = router;
