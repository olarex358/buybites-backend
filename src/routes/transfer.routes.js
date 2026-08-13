const router = require("express").Router();
const crypto = require("crypto");
const { z } = require("zod");

const User = require("../models/User");
const WalletTx = require("../models/WalletTx");
const Beneficiary = require("../models/Beneficiary");
const { auth } = require("../middleware/auth");
const { notify } = require("../services/notification.service");
const {
  listBanks,
  resolveBankAccount,
  createPayout,
  queryPayout,
} = require("../services/korapay.transfer.service");

const ENABLED = String(process.env.KORAPAY_PAYOUTS_ENABLED || "false").toLowerCase() === "true";
const MIN_TRANSFER = Number(process.env.NEX_MIN_TRANSFER || 100);
const MAX_TRANSFER = Number(process.env.NEX_MAX_TRANSFER || 500000);

function reference() {
  return `NEX_TRF_${Date.now()}_${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}

router.get("/banks", auth, async (req, res, next) => {
  try {
    const result = await listBanks("NG");
    const banks = Array.isArray(result?.data)
      ? result.data.map((b) => ({ name: b.name, code: b.code, slug: b.slug, country: b.country }))
      : [];
    return res.success({ banks }, "Banks fetched");
  } catch (e) {
    next(e);
  }
});

router.post("/resolve", auth, async (req, res, next) => {
  try {
    const schema = z.object({
      bankCode: z.string().min(2).max(20),
      accountNumber: z.string().regex(/^\d{10}$/),
    });
    const body = schema.parse(req.body || {});
    const result = await resolveBankAccount({
      bank: body.bankCode,
      account: body.accountNumber,
    });

    if (!result?.status || !result?.data?.account_name) {
      return res.fail("Could not verify that bank account.", 400);
    }

    return res.success({
      account: {
        bankCode: String(result.data.bank_code || body.bankCode),
        bankName: result.data.bank_name || "",
        accountNumber: result.data.account_number || body.accountNumber,
        accountName: result.data.account_name,
        status: result.data.status || "available",
      },
    }, "Bank account verified");
  } catch (e) {
    if (e.name === "ZodError") return res.fail("Invalid bank details.", 400);
    next(e);
  }
});

router.get("/beneficiaries", auth, async (req, res, next) => {
  try {
    const beneficiaries = await Beneficiary.find({
      userId: req.user.sub,
      isActive: true,
    }).sort({ lastUsedAt: -1, createdAt: -1 }).limit(50).lean();

    return res.success({ beneficiaries }, "Beneficiaries fetched");
  } catch (e) {
    next(e);
  }
});

router.post("/beneficiaries", auth, async (req, res, next) => {
  try {
    const schema = z.object({
      bankCode: z.string().min(2).max(20),
      bankName: z.string().max(100).optional().default(""),
      accountNumber: z.string().regex(/^\d{10}$/),
      accountName: z.string().min(2).max(120),
      label: z.string().max(60).optional().default(""),
    });
    const body = schema.parse(req.body || {});

    const beneficiary = await Beneficiary.findOneAndUpdate(
      { userId: req.user.sub, bankCode: body.bankCode, accountNumber: body.accountNumber },
      {
        $set: {
          bankName: body.bankName,
          accountName: body.accountName,
          label: body.label,
          verifiedAt: new Date(),
          isActive: true,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.success({ beneficiary }, "Beneficiary saved");
  } catch (e) {
    if (e.name === "ZodError") return res.fail("Invalid beneficiary details.", 400);
    next(e);
  }
});

router.post("/", auth, async (req, res, next) => {
  if (!ENABLED) return res.fail("Bank transfers are not enabled yet.", 503);

  try {
    const schema = z.object({
      amount: z.number().positive(),
      bankCode: z.string().min(2).max(20),
      accountNumber: z.string().regex(/^\d{10}$/),
      accountName: z.string().min(2).max(120),
      bankName: z.string().max(100).optional().default(""),
      narration: z.string().max(80).optional().default("NEX transfer"),
    });
    const body = schema.parse(req.body || {});

    if (body.amount < MIN_TRANSFER) return res.fail(`Minimum transfer is ₦${MIN_TRANSFER.toLocaleString()}.`, 400);
    if (body.amount > MAX_TRANSFER) return res.fail(`Maximum transfer is ₦${MAX_TRANSFER.toLocaleString()}.`, 400);

    const resolved = await resolveBankAccount({ bank: body.bankCode, account: body.accountNumber });
    if (!resolved?.status || !resolved?.data?.account_name) {
      return res.fail("Could not verify the destination account.", 400);
    }

    const resolvedName = String(resolved.data.account_name).trim();
    if (resolvedName.toLowerCase() !== body.accountName.trim().toLowerCase()) {
      return res.fail("The account name changed. Please verify the account again.", 409);
    }

    const user = await User.findById(req.user.sub).select("walletBalance fullName email phone");
    if (!user) return res.fail("User not found.", 404);

    const updatedUser = await User.findOneAndUpdate(
      { _id: user._id, walletBalance: { $gte: body.amount } },
      { $inc: { walletBalance: -body.amount } },
      { new: true }
    );
    if (!updatedUser) return res.fail("Insufficient wallet balance.", 400);

    const ref = reference();
    let walletTx;

    try {
      walletTx = await WalletTx.create({
        userId: user._id,
        type: "DEBIT",
        amount: body.amount,
        reference: ref,
        status: "PENDING",
        provider: "KORAPAY",
        meta: {
          purpose: "WALLET_TRANSFER",
          bankCode: body.bankCode,
          bankName: body.bankName || resolved.data.bank_name || "",
          accountNumber: body.accountNumber,
          accountName: resolvedName,
          narration: body.narration,
          reservedAt: new Date(),
        },
      });
    } catch (e) {
      await User.findByIdAndUpdate(user._id, { $inc: { walletBalance: body.amount } });
      throw e;
    }

    const notificationUrl =
      `${process.env.BACKEND_URL}/api/transfer/korapay/webhook`;

    try {
      const payout = await createPayout({
        reference: ref,
        amount: body.amount,
        bankCode: body.bankCode,
        accountNumber: body.accountNumber,
        narration: body.narration,
        customerName: user.fullName || resolvedName,
        customerEmail: user.email || `${user.phone}@nex.app`,
        notificationUrl,
      });

      walletTx.providerReference = payout?.data?.reference || ref;
      walletTx.meta = {
        ...(walletTx.meta || {}),
        providerStatus: String(payout?.data?.status || "").toLowerCase(),
        providerResponse: {
          status: payout?.status,
          message: payout?.message,
          fee: payout?.data?.fee,
        },
      };

      const providerStatus = String(payout?.data?.status || "").toLowerCase();

      if (providerStatus === "failed") {
        walletTx.status = "FAILED";
        walletTx.meta.failedAt = new Date();
        walletTx.meta.refundedAt = new Date();
        await walletTx.save();

        await User.findByIdAndUpdate(user._id, { $inc: { walletBalance: body.amount } });
        await notify({
          userId: user._id,
          type: "TRANSFER_REFUNDED",
          title: "Transfer failed — wallet refunded",
          message: `₦${body.amount.toLocaleString()} has been returned to your NEX wallet.`,
          dedupeKey: `transfer-refund:${ref}`,
        });

        return res.fail("Transfer failed. Your wallet has been refunded.", 400);
      }

      await walletTx.save();

      await notify({
        userId: user._id,
        type: "TRANSFER_PROCESSING",
        title: "Bank transfer processing",
        message: `Your ₦${body.amount.toLocaleString()} transfer to ${resolvedName} is being processed.`,
        dedupeKey: `transfer-processing:${ref}`,
      });

      return res.success({
        reference: ref,
        status: "PROCESSING",
        amount: body.amount,
        accountName: resolvedName,
        walletBalance: updatedUser.walletBalance,
      }, "Transfer submitted");
    } catch (providerError) {
      walletTx.meta = {
        ...(walletTx.meta || {}),
        providerStatus: "UNKNOWN",
        providerError: providerError?.response?.data?.message || providerError.message,
        uncertainAt: new Date(),
      };
      await walletTx.save();

      await notify({
        userId: user._id,
        type: "TRANSFER_PROCESSING",
        title: "Transfer status is being confirmed",
        message: `Your ₦${body.amount.toLocaleString()} transfer is being checked automatically.`,
        dedupeKey: `transfer-uncertain:${ref}`,
      });

      return res.success({
        reference: ref,
        status: "PROCESSING",
        uncertain: true,
        amount: body.amount,
        walletBalance: updatedUser.walletBalance,
      }, "Transfer submitted; confirmation pending");
    }
  } catch (e) {
    if (e.name === "ZodError") return res.fail("Invalid transfer details.", 400);
    next(e);
  }
});

router.get("/:reference", auth, async (req, res, next) => {
  try {
    const tx = await WalletTx.findOne({
      reference: req.params.reference,
      userId: req.user.sub,
      type: "DEBIT",
    }).lean();

    if (!tx) return res.fail("Transfer not found.", 404);

    return res.success({
      reference: tx.reference,
      status: tx.status,
      amount: tx.amount,
      providerReference: tx.providerReference,
      meta: tx.meta,
    }, "Transfer status fetched");
  } catch (e) {
    next(e);
  }
});

module.exports = router;
