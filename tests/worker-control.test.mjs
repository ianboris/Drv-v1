import test from "node:test";
import assert from "node:assert/strict";
import { reserveOrder } from "../worker/control.mjs";

function mockSql(control) {
  return async (strings, ...values) => {
    const [orderUid, epoch] = values;
    if (control.stopRequested || control.buyUnknown || control.workerEpoch !== epoch) return [];
    if (control.inFlight && control.inFlight !== orderUid) return [];
    control.inFlight = orderUid;
    return [{ owner_id: "primary" }];
  };
}

test("reservation is atomic with Stop: second gate fails after Stop", async () => {
  const control = { stopRequested: false, buyUnknown: false, workerEpoch: 7, inFlight: null };
  const sql = mockSql(control);
  assert.equal(await reserveOrder(sql, "order-a", 7), true); // reserve before proposal
  control.stopRequested = true; // operator Stop races the proposal response
  assert.equal(await reserveOrder(sql, "order-a", 7), false); // revalidate before buy
});

test("reservation rejects a stale epoch", async () => {
  const control = { stopRequested: false, buyUnknown: false, workerEpoch: 8, inFlight: null };
  assert.equal(await reserveOrder(mockSql(control), "old-order", 7), false);
});

test("reservation cannot take another order's slot", async () => {
  const control = { stopRequested: false, buyUnknown: false, workerEpoch: 7, inFlight: "other-order" };
  assert.equal(await reserveOrder(mockSql(control), "order-a", 7), false);
});
