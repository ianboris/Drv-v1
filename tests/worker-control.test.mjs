import test from "node:test";
import assert from "node:assert/strict";
import { claimWorkerLease, reserveOrder } from "../worker/control.mjs";

function mockSql(control) {
  return async (strings, ...values) => {
    const query = strings.join(" ");
    if (query.includes("worker_lease_expires_at = NOW()")) {
      const [instanceId, epoch] = values;
      if (control.workerEpoch !== epoch) return [];
      const expired = !control.leaseUntil || control.leaseUntil <= Date.now();
      if (control.instanceId && control.instanceId !== instanceId && !expired) return [];
      if (!control.desired && !control.inFlight && !(control.buyUnknown && control.reconcile)) return [];
      control.instanceId = instanceId;
      control.leaseUntil = Date.now() + 20000;
      return [{ worker_epoch: epoch }];
    }
    const [orderUid, epoch, instanceId] = values;
    if (control.stopRequested || control.buyUnknown || control.workerEpoch !== epoch ||
        control.instanceId !== instanceId || control.leaseUntil <= Date.now()) return [];
    if (control.inFlight && control.inFlight !== orderUid) return [];
    control.inFlight = orderUid;
    return [{ owner_id: "primary" }];
  };
}

test("only one process can own a worker epoch lease", async () => {
  const control = { workerEpoch: 7, desired: true, stopRequested: false, leaseUntil: null };
  const sql = mockSql(control);
  assert.equal(await claimWorkerLease(sql, 7, "worker-a"), true);
  assert.equal(await claimWorkerLease(sql, 7, "worker-b"), false);
});

test("reservation is atomic with Stop: second gate fails after Stop", async () => {
  const control = { workerEpoch: 7, desired: true, stopRequested: false, buyUnknown: false, leaseUntil: Date.now()+20000, instanceId: "worker-a", inFlight: null };
  const sql = mockSql(control);
  assert.equal(await reserveOrder(sql, "order-a", 7, "worker-a"), true);
  control.stopRequested = true;
  assert.equal(await reserveOrder(sql, "order-a", 7, "worker-a"), false);
});

test("reservation rejects a stale epoch", async () => {
  const control = { workerEpoch: 8, stopRequested: false, buyUnknown: false, leaseUntil: Date.now()+20000, instanceId: "worker-a", inFlight: null };
  assert.equal(await reserveOrder(mockSql(control), "old-order", 7, "worker-a"), false);
});

test("reservation rejects a different worker instance", async () => {
  const control = { workerEpoch: 7, stopRequested: false, buyUnknown: false, leaseUntil: Date.now()+20000, instanceId: "worker-b", inFlight: null };
  assert.equal(await reserveOrder(mockSql(control), "order-a", 7, "worker-a"), false);
});

test("reservation cannot take another order's slot", async () => {
  const control = { workerEpoch: 7, stopRequested: false, buyUnknown: false, leaseUntil: Date.now()+20000, instanceId: "worker-a", inFlight: "other-order" };
  assert.equal(await reserveOrder(mockSql(control), "order-a", 7, "worker-a"), false);
});
