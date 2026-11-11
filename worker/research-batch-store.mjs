import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

const stableTick = tick => ({
  symbol: String(tick.symbol),
  epoch: Number(tick.epoch),
  quote: String(tick.quote),
  pip_size: Number(tick.pip_size),
  digit: Number(tick.digit),
  tick_uid: String(tick.tick_uid),
  source: String(tick.source || "live")
});

export function canonicalBatch(ticks) {
  if (!Array.isArray(ticks) || ticks.length === 0) throw new Error("A research batch must contain ticks");
  const normalized = ticks.map(stableTick);
  for (const t of normalized) {
    if (!t.symbol || !Number.isSafeInteger(t.epoch) || !Number.isFinite(Number(t.quote)) ||
        !Number.isInteger(t.pip_size) || t.pip_size < 0 || t.pip_size > 10 ||
        !Number.isInteger(t.digit) || t.digit < 0 || t.digit > 9 || !t.tick_uid) {
      throw new Error("Invalid tick in research batch");
    }
  }
  const payload = normalized.map(t => JSON.stringify(t)).join("\n") + "\n";
  const checksum = createHash("sha256").update(payload).digest("hex");
  const batchId = createHash("sha256").update("lotus-research-batch-v1\0").update(payload).digest("hex");
  return { batchId, checksum, payload, ticks: normalized };
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function writeBatchSegment(directory, ticks) {
  const batch = canonicalBatch(ticks);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const finalPath = path.join(directory, `batch-v1-${batch.batchId}.jsonl.gz`);
  try {
    const existing = await readFile(finalPath);
    const decoded = gunzipSync(existing).toString("utf8");
    if (decoded !== batch.payload) throw new Error("Batch ID collision or corrupt existing archive segment");
    return { ...batch, path: finalPath, alreadyArchived: true };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const tempPath = path.join(directory, `.tmp-${batch.batchId}-${process.pid}-${Date.now()}`);
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(gzipSync(Buffer.from(batch.payload), { level: 6 }));
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
  await handle.close();
  try {
    await rename(tempPath, finalPath);
    await syncDirectory(directory);
  } catch (error) {
    const existing = await readFile(finalPath).catch(() => null);
    if (!existing || gunzipSync(existing).toString("utf8") !== batch.payload) throw error;
  }
  return { ...batch, path: finalPath, alreadyArchived: false };
}

export async function readBatchSegment(filePath) {
  const raw = gunzipSync(await readFile(filePath)).toString("utf8");
  const ticks = raw.trimEnd().split("\n").map(line => JSON.parse(line));
  return { ...canonicalBatch(ticks), path: filePath, alreadyArchived: true };
}

export async function listBatchSegments(directory) {
  const names = await readdir(directory).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
  return names.filter(name => /^batch-v1-[a-f0-9]{64}\.jsonl\.gz$/.test(name))
    .sort().map(name => path.join(directory, name));
}
