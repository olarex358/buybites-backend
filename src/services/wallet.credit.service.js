const mongoose = require("mongoose");
const WalletTx = require("../models/WalletTx");
const User = require("../models/User");
const { notify } = require("./notification.service");

/**
 * Atomically credit a user's wallet from a verified payment.
 *
 * The WalletTx reference is the idempotency key. The ledger status transition
 * and wallet balance increment are committed in the same MongoDB transaction,
 * so we cannot end up with a SUCCESS funding record without the wallet credit
 * (or vice versa).
 */
async function creditWalletFromPayment({
  userId,
  reference,
  amount,
  provider = "KORAPAY",
  meta = {},
  title = "Wallet funded",
  message,
}) {
  if (!userId || !reference || !Number(amount) || Number(amount) <= 0) {
    throw new Error("Invalid wallet credit parameters");
  }

  const normalizedAmount = Number(amount);
  const session = await mongoose.startSession();
  let result;

  try {
    await session.withTransaction(async () => {
      let walletTx = await WalletTx.findOne({ reference }).session(session);

      if (walletTx?.status === "SUCCESS") {
        result = {
          credited: false,
          alreadyProcessed: true,
          walletTx,
        };
        return;
      }

      if (walletTx) {
        // Claim the pending/non-success ledger row atomically. Only the caller
        // that wins this transition is allowed to credit the wallet.
        const flipped = await WalletTx.findOneAndUpdate(
          { _id: walletTx._id, status: { $ne: "SUCCESS" } },
          {
            $set: {
              status: "SUCCESS",
              provider,
              amount: normalizedAmount,
              meta: { ...(walletTx.meta || {}), ...meta },
            },
          },
          { new: true, session }
        );

        if (!flipped) {
          result = {
            credited: false,
            alreadyProcessed: true,
            walletTx,
          };
          return;
        }

        await User.findByIdAndUpdate(
          userId,
          { $inc: { walletBalance: normalizedAmount } },
          { session }
        );

        result = {
          credited: true,
          alreadyProcessed: false,
          walletTx: flipped,
        };
        return;
      }

      // No ledger row exists yet. The unique reference on WalletTx prevents
      // duplicate credits if concurrent webhook/requery requests race here.
      walletTx = await WalletTx.create(
        [
          {
            userId,
            type: "FUND",
            amount: normalizedAmount,
            reference,
            status: "SUCCESS",
            provider,
            meta,
          },
        ],
        { session }
      ).then((rows) => rows[0]);

      await User.findByIdAndUpdate(
        userId,
        { $inc: { walletBalance: normalizedAmount } },
        { session }
      );

      result = {
        credited: true,
        alreadyProcessed: false,
        walletTx,
      };
    });
  } catch (error) {
    // If another webhook/requery won the unique reference race, resolve the
    // winner and let the idempotency check return without another credit.
    if (error?.code === 11000) {
      const existing = await WalletTx.findOne({ reference }).lean();
      if (existing?.status === "SUCCESS") {
        return {
          credited: false,
          alreadyProcessed: true,
          walletTx: existing,
        };
      }
    }
    throw error;
  } finally {
    await session.endSession();
  }

  if (result?.credited) {
    await notify({
      userId,
      type: "WALLET_FUND",
      title,
      message:
        message ||
        `₦${normalizedAmount.toLocaleString()} has been added to your NEX wallet.`,
      dedupeKey: `wallet-fund:${reference}`,
    });
  }

  return result;
}

module.exports = { creditWalletFromPayment };
