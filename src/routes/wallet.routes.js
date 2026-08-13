const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const router = express.Router();

const { auth } = require("../middleware/auth");
const WalletTx = require("../models/WalletTx");
const User = require("../models/User");
const { creditWalletFromPayment } = require("../services/wallet.credit.service");
const { notify } = require("../services/notification.service");
const { initializeCheckout, verifyCheckout } = require("../services/payment.providers");
const WalletFundingEvent = require("../models/WalletFundingEvent");

const KORA_BASE = "https://api.korapay.com/merchant/api/v1";
const KORA_SECRET = process.env.KORAPAY_SECRET_KEY;
const KORA_PUBLIC = process.env.KORAPAY_PUBLIC_KEY;
const FUNDING_PROVIDER = String(process.env.NEX_FUNDING_PROVIDER || "KORAPAY").toUpperCase();
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

async function koraRequest(method, path, data = null) {
  if (!KORA_SECRET) throw new Error("Korapay secret key is not configured");
  const res = await axios({
    method,
    url: `${KORA_BASE}${path}`,
    headers: {
      Authorization: `Bearer ${KORA_SECRET}`,
      "Content-Type": "application/json",
    },
    data,
    timeout: 15000,
  });
  return res.data;
}

router.get("/balance", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.sub).select("walletBalance");
    res.success({ walletBalance: user?.walletBalance ?? 0 });
  } catch (e) {
    res.fail(e.message || "Could not fetch balance", 500);
  }
});

router.post("/fund/init", auth, async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!amount || amount < 100) {
      return res.fail("Minimum funding amount is ₦100", 400);
    }
    if (amount > 5_000_000) {
      return res.fail("Maximum funding amount is ₦5,000,000", 400);
    }

    const idempotencyKey =
      req.headers["x-idempotency-key"] ||
      req.headers["x-idempotency_key"] ||
      "";

    if (idempotencyKey) {
      const existing = await WalletTx.findOne({
        userId: req.user.sub,
        idempotencyKey,
      }).lean();

      if (existing?.meta?.checkout_url) {
        return res.success({
          checkout_url: existing.meta.checkout_url,
          reference: existing.reference,
          public_key: KORA_PUBLIC,
          deduped: true,
        }, "Existing funding request returned");
      }
    }

    const user = await User.findById(req.user.sub).select("phone fullName email");
    if (!user) return res.fail("User not found", 404);

    const reference = `NEX_FUND_${Date.now()}_${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    const response = await initializeCheckout({
      provider: FUNDING_PROVIDER,
      reference,
      amount,
      customer: {
        name: user.fullName || user.phone,
        email: user.email || `${user.phone}@nex.app`,
        phone: user.phone,
      },
      notificationUrl:
        FUNDING_PROVIDER === "KORAPAY"
          ? `${process.env.BACKEND_URL}/api/wallet/korapay/webhook`
          : `${process.env.BACKEND_URL}/api/paystack/webhook`,
      redirectUrl: `${FRONTEND_URL}/callback?ref=${reference}`,
      metadata: {
        userId: String(user._id),
        phone: user.phone,
        reference,
        purpose: "WALLET_FUND",
      },
    });

    if (!response.checkoutUrl) {
      throw new Error(`${FUNDING_PROVIDER} did not return a checkout URL`);
    }

    await WalletTx.create({
      userId: user._id,
      type: "FUND",
      amount,
      amountPaid: Number(req.body.totalAmount || amount),
      reference,
      status: "PENDING",
      provider: FUNDING_PROVIDER,
      idempotencyKey,
      meta: {
        checkout_url: response.checkoutUrl,
        purpose: "WALLET_FUND",
      },
    });

    res.success({
      checkout_url: response.checkoutUrl,
      reference,
      provider: FUNDING_PROVIDER,
      public_key: FUNDING_PROVIDER === "KORAPAY" ? KORA_PUBLIC : undefined,
    }, "Funding initialized");
  } catch (e) {
    console.error("[wallet/fund/init]", e?.response?.data || e.message);
    res.fail(e?.response?.data?.message || e.message || "Failed to initialize payment", 500);
  }
});

router.get("/verify/:reference", auth, async (req, res) => {
  try {
    const { reference } = req.params;
    const walletTx = await WalletTx.findOne({
      reference,
      userId: req.user.sub,
      type: "FUND",
    });

    if (!walletTx) return res.fail("Transaction not found", 404);

    if (walletTx.status === "PENDING") {
      try {
        const verified = await verifyCheckout(
          walletTx.provider || FUNDING_PROVIDER,
          reference
        );

        await WalletFundingEvent.create({
          userId: walletTx.userId,
          walletTxId: walletTx._id,
          provider: walletTx.provider || FUNDING_PROVIDER,
          event: "CHECKOUT_VERIFY",
          reference,
          amount: verified.amountPaid || walletTx.amount,
          status: verified.status,
          source: "CHECKOUT",
          meta: { providerReference: verified.providerReference },
        });

        if (verified.status === "SUCCESS") {
          await creditWalletFromPayment({
            userId: req.user.sub,
            reference,
            amount: Number(walletTx.amount),
            provider: walletTx.provider || FUNDING_PROVIDER,
            meta: {
              ...(walletTx.meta || {}),
              providerReference: verified.providerReference,
              verifiedVia: "callback",
            },
            title: "Wallet funding confirmed",
            message: `₦${Number(walletTx.amount).toLocaleString()} has been confirmed and added to your NEX wallet.`,
          });
        }
      } catch (verifyError) {
        // Keep PENDING. The webhook or the user-facing requery can resolve it.
        console.warn("[wallet/verify]", verifyError?.response?.data || verifyError.message);
      }
    }

    const latest = await WalletTx.findOne({
      reference,
      userId: req.user.sub,
    }).lean();
    const user = await User.findById(req.user.sub).select("walletBalance").lean();

    return res.success({
      status: latest?.status || walletTx.status,
      amount: latest?.amount || walletTx.amount,
      reference,
      provider: latest?.provider || walletTx.provider,
      walletBalance: user?.walletBalance ?? 0,
    }, "Wallet funding status fetched");
  } catch (e) {
    return res.fail(e.message || "Verification failed", 500);
  }
});

router.post("/requery/:reference", auth, async (req, res) => {
  try {
    const walletTx = await WalletTx.findOne({
      reference: req.params.reference,
      userId: req.user.sub,
      type: "FUND",
    });

    if (!walletTx) return res.fail("Funding transaction not found", 404);

    if (walletTx.status === "SUCCESS") {
      return res.success({
        status: "SUCCESS",
        amount: walletTx.amount,
        reference: walletTx.reference,
        walletBalance: (await User.findById(req.user.sub).select("walletBalance"))?.walletBalance ?? 0,
      }, "Funding already confirmed");
    }

    const verified = await verifyCheckout(walletTx.provider || FUNDING_PROVIDER, walletTx.reference);

    await WalletFundingEvent.create({
      userId: walletTx.userId,
      walletTxId: walletTx._id,
      provider: walletTx.provider || FUNDING_PROVIDER,
      event: "CHECKOUT_REQUERY",
      reference: walletTx.reference,
      amount: verified.amountPaid || walletTx.amount,
      status: verified.status,
      source: "REQUERY",
      meta: { providerReference: verified.providerReference },
    });

    if (verified.status === "SUCCESS") {
      await creditWalletFromPayment({
        userId: walletTx.userId,
        reference: walletTx.reference,
        amount: Number(walletTx.amount),
        provider: walletTx.provider || FUNDING_PROVIDER,
        meta: {
          ...(walletTx.meta || {}),
          providerReference: verified.providerReference,
          verifiedVia: "requery",
        },
        title: "Wallet funding confirmed",
        message: `₦${Number(walletTx.amount).toLocaleString()} has been confirmed and added to your NEX wallet.`,
      });
    }

    const latest = await WalletTx.findOne({
      _id: walletTx._id,
    }).lean();
    const user = await User.findById(req.user.sub).select("walletBalance").lean();

    return res.success({
      status: latest?.status || walletTx.status,
      amount: latest?.amount || walletTx.amount,
      reference: walletTx.reference,
      provider: walletTx.provider,
      walletBalance: user?.walletBalance ?? 0,
    }, "Funding status checked");
  } catch (e) {
    console.error("[wallet/requery]", e?.response?.data || e.message);
    return res.fail(e.message || "Could not requery funding", 502);
  }
});

router.get("/history", auth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const txs = await WalletTx.find({ userId: req.user.sub })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.success({ transactions: txs }, "Wallet history fetched");
  } catch (e) {
    res.fail(e.message || "Could not fetch wallet history", 500);
  }
});

module.exports = router;
