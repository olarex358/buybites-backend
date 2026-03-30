const Transaction = require("../models/Transaction");
const User = require("../models/User");
const { newReference } = require("./tx.utils");

/**
 * Handle Airtime to Cash requests.
 * These are manual and stay in PROCESSING/PENDING until an admin approves.
 */
async function createA2CTx({ userId, body, idempotencyKey }) {
  const { network, amount, expectedPayout } = body;

  // FIX: Validate required fields before creating Transaction
  if (!network || !amount || Number(amount) < 100) {
    const err = new Error("Network and minimum ₦100 airtime amount are required");
    err.status = 400;
    throw err;
  }

  const reference = newReference("A2C");
  const sendTo = process.env.A2C_SEND_TO || "070XXXXXXXX"; // Set A2C_SEND_TO in .env

  const airtimeAmt = Number(amount);
  const payoutAmt  = Number(expectedPayout || Math.floor(airtimeAmt * 0.8));

  // FIX: amount should be the airtime value sent (what we receive from user)
  // expectedPayout (what we pay out) is stored in meta, not as the main amount
  const tx = await Transaction.create({
    userId,
    type: "AIRTIME_TO_CASH",
    provider: "MANUAL",
    sellPrice: airtimeAmt,   // airtime value received from user
    baseCost: payoutAmt,     // what we pay out (our cost)
    profit: airtimeAmt - payoutAmt,
    amount: airtimeAmt,
    reference,
    idempotencyKey: idempotencyKey || "",
    status: "PROCESSING",
    meta: {
      network,
      requestedAmount: airtimeAmt,
      expectedPayout: payoutAmt,
      sendTo,
      instructions: `Send ${network} airtime worth ₦${airtimeAmt.toLocaleString()} to ${sendTo}`,
    },
  });

  return { tx, sendTo };
}

/**
 * Handle Exam PIN purchases.
 * For now, returning successful with a placeholder PIN OR marking as processing.
 */
async function createExamPinTx({ userId, body, idempotencyKey }) {
  const { examType, quantity, phone, amount } = body;

  // FIX: Validate inputs
  if (!examType || !phone || !amount || Number(amount) <= 0 || !quantity || Number(quantity) < 1) {
    const err = new Error("examType, phone, quantity and amount are required");
    err.status = 400;
    throw err;
  }

  const reference = newReference("EXM");

  const tx = await Transaction.create({
    userId,
    type: "EXAM_PIN",
    provider: "MANUAL",
    sellPrice: amount,
    baseCost: amount * 0.95, // Assume 5% profit for now
    profit: amount * 0.05,
    amount: amount,
    reference,
    idempotencyKey: idempotencyKey || "",
    status: "PROCESSING",
    meta: {
      examType,
      quantity,
      phone,
      pins: [] // To be filled by admin or provider
    },
  });

  return { tx };
}

module.exports = { createA2CTx, createExamPinTx };
