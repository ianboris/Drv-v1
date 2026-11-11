import test from "node:test";
import assert from "node:assert/strict";
import {
  assertRiskAllowed, digitFromQuote, leastFrequentDigit,
  payoutAdjustedEv, wilsonLowerBound,
} from "../worker/risk.mjs";

const base = {
  stopRequested: false, buyUnknown: false, workerEpoch: 4, currentEpoch: 4,
  inFlightOrderUid: null, orderUid: "order-1", balance: 100, stake: 0.5,
  maxStakePct: 0.01, dailyNetPl: 0, dailyLossLimit: 2,
  consecutiveLosses: 0, consecutiveLossLimit: 3,
  mode: "PLUMBING_TEST", plumbingRemaining: 10,
};

test("risk gate accepts a valid demo plumbing order", () => {
  assert.equal(assertRiskAllowed(base), true);
});
test("Stop blocks a purchase", () => {
  assert.throws(() => assertRiskAllowed({ ...base, stopRequested: true }), /STOP_REQUESTED/);
});
test("unknown buy blocks all purchases", () => {
  assert.throws(() => assertRiskAllowed({ ...base, buyUnknown: true }), /BUY_UNKNOWN/);
});
test("stale worker epoch is rejected", () => {
  assert.throws(() => assertRiskAllowed({ ...base, workerEpoch: 3 }), /STALE_WORKER_EPOCH/);
});
test("occupied order slot is rejected", () => {
  assert.throws(() => assertRiskAllowed({ ...base, inFlightOrderUid: "other-order" }), /ORDER_SLOT_OCCUPIED/);
});
test("stake percentage cap is enforced", () => {
  assert.throws(() => assertRiskAllowed({ ...base, stake: 1.01 }), /STAKE_EXCEEDS/);
});
test("daily loss cap is enforced", () => {
  assert.throws(() => assertRiskAllowed({ ...base, dailyNetPl: -2 }), /DAILY_LOSS/);
});
test("consecutive loss cap is enforced", () => {
  assert.throws(() => assertRiskAllowed({ ...base, consecutiveLosses: 3 }), /CONSECUTIVE_LOSS/);
});
test("plumbing cap is enforced", () => {
  assert.throws(() => assertRiskAllowed({ ...base, plumbingRemaining: 0 }), /PLUMBING_TRADE_CAP/);
});
test("digit extraction uses explicit Deriv pip size", () => {
  assert.equal(digitFromQuote(123.45, 2), 5);
  assert.equal(digitFromQuote(123.4, 2), 0);
});
test("least-frequency selection requires at least 50 digits", () => {
  assert.throws(() => leastFrequentDigit([1, 2, 3]), /50 valid/);
  assert.equal(leastFrequentDigit(Array(50).fill(1).concat(Array(50).fill(2))), 0);
});
test("payout-adjusted EV uses gross payout including stake", () => {
  assert.ok(Math.abs(payoutAdjustedEv(0.9, 0.38, 0.35) - (-0.008)) < 1e-12);
});
test("Wilson lower bound is bounded and below the observed rate", () => {
  const lower = wilsonLowerBound(90, 100);
  assert.ok(lower > 0 && lower < 0.9);
  assert.equal(wilsonLowerBound(0, 0), null);
});
