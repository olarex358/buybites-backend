const Transaction = require("../models/Transaction");
const User = require("../models/User");
const { newReference } = require("./tx.utils");

/**
 * Handle Airtime to Cash requests.
 * These are manual and stay in PROCESSING/PENDING until an admin approves.
 */
async function createA2CTx({ userId, body, idempotencyKey }) {
  const { network, amount, expectedPayout } = body;

  const reference = newReference("A2C");
  const sendTo = process.env.A2C_SEND_TO || "070XXXXXXXX"; // Placeholder

  const tx = await Transaction.create({
    userId,
    type: "AIRTIME_TO_CASH",
    provider: "MANUAL",
    sellPrice: 0,
    baseCost: 0,
    profit: 0,
    amount: Number(expectedPayout || 0),
    reference,
    idempotencyKey: idempotencyKey || "",
    status: "PROCESSING",
    meta: {
      network,
      requestedAmount: amount,
      expectedPayout,
      sendTo,
      instructions: `Send ${network} airtime to ${sendTo}`
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
