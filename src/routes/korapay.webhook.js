const crypto = require("crypto");
const router = require("express").Router();
const axios = require("axios");

const WalletTx = require("../models/WalletTx");
const VirtualAccount = require("../models/VirtualAccount");
const { creditWalletFromPayment } = require("../services/wallet.credit.service");
const WalletFundingEvent = require("../models/WalletFundingEvent");

const KORA_BASE = "https://api.korapay.com/merchant/api/v1";
const KORA_SECRET =
  String(process.env.KORAPAY_MODE || "live").toLowerCase() === "sandbox"
    ? process.env.KORAPAY_TEST_SECRET_KEY
    : process.env.KORAPAY_SECRET_KEY;
const WEBHOOK_SECRET = process.env.KORAPAY_WEBHOOK_SECRET;

async function koraVerify(reference) {
  if (!KORA_SECRET) throw new Error("Korapay secret key is not configured");
  const res = await axios.get(`${KORA_BASE}/charges/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${KORA_SECRET}` },
    timeout: 10000,
  });
  return res.data;
}

router.post("/", async (req, res) => {
  try {
    const signature = req.headers["x-korapay-signature"];
    if (!signature || !WEBHOOK_SECRET) {
      return res.status(400).json({ error: "Missing signature config" });
    }

    const body = req.body.toString("utf8");
    const expected = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(body)
      .digest("hex");

    const a = Buffer.from(String(expected));
    const b = Buffer.from(String(signature));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      console.warn("[korapay webhook] Invalid signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = JSON.parse(body);
    if (event.event !== "charge.success") {
      return res.status(200).json({ received: true });
    }

    const data = event.data || {};
    const reference = data.reference || data.payment_reference;
    if (!reference || String(data.status).toLowerCase() !== "success") {
      return res.status(200).json({ received: true });
    }

    // Never trust the webhook alone for a wallet credit.
    // Re-query Korapay and require a confirmed successful charge.
    let verified;
    try {
      verified = await koraVerify(reference);
    } catch (error) {
      console.error("[korapay webhook] verification failed:", error.message);
      // Returning 500 lets Korapay retry the webhook.
      return res.status(500).json({ error: "Verification temporarily unavailable" });
    }

    if (String(verified?.data?.status).toLowerCase() !== "success") {
      return res.status(200).json({ received: true });
    }

    const verifiedData = verified.data;

    const pendingForEvent = await WalletTx.findOne({
      reference,
      type: "FUND",
      provider: "KORAPAY",
    }).select("userId _id amount");

    if (pendingForEvent) {
      await WalletFundingEvent.create({
        userId: pendingForEvent.userId,
        walletTxId: pendingForEvent._id,
        provider: "KORAPAY",
        event: "CHARGE_SUCCESS",
        reference,
        amount: Number(data.amount || verifiedData.amount || 0),
        status: "SUCCESS",
        source: "WEBHOOK",
        meta: { providerReference: verifiedData.reference || reference },
      }).catch((e) => console.error("[korapay webhook] audit event:", e.message));
    }

    const amount = Number(
      verifiedData.amount_paid || verifiedData.amount || data.amount || 0
    );

    if (!amount || amount <= 0) {
      return res.status(200).json({ received: true });
    }

    // Dedicated/virtual-account payment
    const vaRef =
      data.virtual_bank_account_details?.virtual_bank_account?.account_reference ||
      verifiedData.virtual_bank_account?.account_reference ||
      "";

    if (vaRef) {
      const account = await VirtualAccount.findOne({ accountReference: vaRef });
      if (!account) {
        console.warn("[korapay webhook] Unknown virtual account:", vaRef);
        return res.status(200).json({ received: true });
      }

      await creditWalletFromPayment({
        userId: account.userId,
        reference,
        amount,
        provider: "KORAPAY",
        meta: {
          purpose: "VIRTUAL_ACCOUNT_FUND",
          virtualAccountId: String(account._id),
          accountReference: vaRef,
          providerReference: reference,
          payer: verifiedData.virtual_bank_account?.payer_bank_account || data.virtual_bank_account_details?.payer_bank_account || null,
        },
        title: "Bank transfer received",
        message: `₦${amount.toLocaleString()} was received into your NEX virtual account and added to your wallet.`,
      });

      return res.status(200).json({ received: true });
    }

    // Existing checkout funding: only resolve a matching pending WalletTx.
    const pending = await WalletTx.findOne({
      reference,
      status: "PENDING",
      provider: "KORAPAY",
    });

    if (pending) {
      // For checkout funding, only the wallet credit amount is applied.
      // Any gateway fee must never be added to the customer's wallet balance.
      await creditWalletFromPayment({
        userId: pending.userId,
        reference,
        amount: Number(pending.amount), 
        provider: "KORAPAY",
        meta: {
          ...(pending.meta || {}),
          purpose: pending.meta?.purpose || "WALLET_FUND",
          providerReference: reference,
          verifiedVia: "webhook",
        },
      });
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("[korapay webhook] Error:", error.message);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
});

module.exports = router;
