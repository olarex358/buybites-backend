const router = require("express").Router();
const crypto = require("crypto");
const { auth } = require("../middleware/auth");
const User = require("../models/User");
const VirtualAccount = require("../models/VirtualAccount");
const {
  isEnabled,
  createKorapayVirtualAccount,
  queryKorapayVirtualAccount,
} = require("../services/korapay.virtual-account.service");

router.get("/", auth, async (req, res, next) => {
  try {
    const account = await VirtualAccount.findOne({ userId: req.user.sub }).lean();

    return res.success({
      enabled: isEnabled(),
      account: account
        ? {
            id: account._id,
            provider: account.provider,
            accountReference: account.accountReference,
            accountNumber: account.accountNumber,
            accountName: account.accountName,
            bankName: account.bankName,
            bankCode: account.bankCode,
            currency: account.currency,
            status: account.status,
            createdAt: account.createdAt,
          }
        : null,
    }, "Virtual account fetched");
  } catch (error) {
    next(error);
  }
});

router.post("/", auth, async (req, res, next) => {
  try {
    if (!isEnabled()) {
      return res.fail("Virtual accounts are not enabled yet.", 503);
    }

    const { bvn, nin, consent, bankCode } = req.body || {};

    if (consent !== true) {
      return res.fail("You must consent to identity verification before creating a virtual account.", 400);
    }

    if (!bvn || !/^\d{11}$/.test(String(bvn))) {
      return res.fail("Enter a valid 11-digit BVN.", 400);
    }

    if (nin && !/^\d{11}$/.test(String(nin))) {
      return res.fail("If provided, NIN must contain 11 digits.", 400);
    }

    const existing = await VirtualAccount.findOne({ userId: req.user.sub });
    if (existing) {
      return res.success({ account: existing }, "Virtual account already exists");
    }

    const user = await User.findById(req.user.sub).select("fullName phone");
    if (!user) return res.fail("User not found", 404);

    const accountName = String(user.fullName || "").trim();
    if (!accountName) {
      return res.fail("Please complete your full name before creating a virtual account.", 400);
    }

    const accountReference =
      `NEX_VA_${String(user._id)}_${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

    const data = await createKorapayVirtualAccount({
      accountName,
      accountReference,
      email: `${user.phone}@nex.app`,
      bvn,
      nin,
      bankCode,
    });

    const account = await VirtualAccount.create({
      userId: user._id,
      provider: "KORAPAY",
      accountReference: data.account_reference || accountReference,
      providerUniqueId: data.unique_id || "",
      accountNumber: data.account_number,
      accountName: data.account_name || accountName,
      bankName: data.bank_name || "",
      bankCode: data.bank_code || bankCode || process.env.KORAPAY_VIRTUAL_ACCOUNT_BANK_CODE || "070",
      currency: data.currency || "NGN",
      status: String(data.account_status || "active").toUpperCase() === "ACTIVE" ? "ACTIVE" : "PENDING",
      meta: { consentAt: new Date(), source: "KORAPAY" },
    });

    return res.success({ account }, "Virtual account created successfully");
  } catch (error) {
    console.error("[virtual-account/create]", error?.response?.data || error.message);
    next(error);
  }
});

router.get("/refresh", auth, async (req, res, next) => {
  try {
    const account = await VirtualAccount.findOne({ userId: req.user.sub });
    if (!account) return res.fail("Virtual account not found", 404);

    const response = await queryKorapayVirtualAccount(account.accountReference);
    const data = response?.data;

    if (data?.account_status) {
      account.status =
        String(data.account_status).toUpperCase() === "ACTIVE" ? "ACTIVE" : account.status;
      account.accountNumber = data.account_number || account.accountNumber;
      account.accountName = data.account_name || account.accountName;
      account.bankName = data.bank_name || account.bankName;
      account.bankCode = data.bank_code || account.bankCode;
      await account.save();
    }

    return res.success({ account }, "Virtual account refreshed");
  } catch (error) {
    console.error("[virtual-account/refresh]", error?.response?.data || error.message);
    next(error);
  }
});

module.exports = router;
