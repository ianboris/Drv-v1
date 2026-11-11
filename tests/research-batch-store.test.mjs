import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalBatch, writeBatchSegment, readBatchSegment, listBatchSegments } from "../worker/research-batch-store.mjs";

const ticks = [
  { symbol:"R_10", epoch:100, quote:"123.45", pip_size:2, digit:5, tick_uid:"a", source:"live" },
  { symbol:"R_10", epoch:101, quote:"123.46", pip_size:2, digit:6, tick_uid:"b", source:"live" }
];

test("batch identity is deterministic and content-sensitive", () => {
  assert.equal(canonicalBatch(ticks).batchId, canonicalBatch(ticks).batchId);
  assert.notEqual(canonicalBatch(ticks).batchId, canonicalBatch([...ticks].reverse()).batchId);
  assert.notEqual(canonicalBatch(ticks).batchId, canonicalBatch([{...ticks[0], quote:"123.47"}, ticks[1]]).batchId);
});

test("archive writes immutable gzip segments and safely reuses exact retries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lotus-batches-"));
  try {
    const first = await writeBatchSegment(dir, ticks);
    const retry = await writeBatchSegment(dir, ticks);
    assert.equal(first.batchId, retry.batchId);
    assert.equal(retry.alreadyArchived, true);
    const loaded = await readBatchSegment(first.path);
    assert.deepEqual(loaded.ticks, ticks);
    assert.equal((await listBatchSegments(dir)).length, 1);
    const raw = await readFile(first.path);
    assert.ok(raw.length > 0);
  } finally { await rm(dir, {recursive:true, force:true}); }
});

test("invalid digits are rejected", () => {
  assert.throws(() => canonicalBatch([{...ticks[0], digit:10}]), /Invalid tick/);
});
