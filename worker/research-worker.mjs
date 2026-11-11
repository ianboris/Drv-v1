import { neon } from "@neondatabase/serverless";
import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { digitFromQuote, normalizePipSize } from "../src/market-data.mjs";

const URL = "wss://api.derivws.com/trading/v1/options/ws/public";
const OWNER = "primary";
const ARCHIVE_DIR = process.env.LOTUS_ARCHIVE_DIR || "/var/lib/lotus/research";
const RETENTION_DAYS = Math.max(7, Number(process.env.LOTUS_ARCHIVE_RETENTION_DAYS || 90));
const FLUSH_COUNT = 500;
const MAX_QUEUE = 25000;
const sql = neon(process.env.DATABASE_URL);
const instance = randomUUID();
let socket, reqId = 10, queue = [], symbols = new Map(), seen = new Map(), flushing = false;
let lastTickAt = null, totalTicks = 0, reconnects = 0, stopping = false, flushTimer, heartbeatTimer;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const utcDay = epoch => new Date(epoch * 1000).toISOString().slice(0, 10);
function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Research WebSocket is not open");
  socket.send(JSON.stringify({ ...payload, req_id: payload.req_id ?? reqId++ }));
}
function remember(key) {
  if (seen.has(key)) return false;
  seen.set(key, true);
  if (seen.size > 100000) seen = new Map([...seen].slice(-50000));
  return true;
}
function acceptTick(tick, source = "live") {
  const symbol = String(tick?.symbol || "");
  const quote = Number(tick?.quote), epoch = Number(tick?.epoch);
  const precision = normalizePipSize(tick?.pip_size, quote) ?? symbols.get(symbol)?.pipSize;
  if (!symbol || !Number.isFinite(quote) || !Number.isSafeInteger(epoch) || precision === undefined) return;
  const digit = digitFromQuote(quote, precision);
  const providerId = tick.id == null ? "" : String(tick.id);
  const uid = providerId ? providerId : `${symbol}:${epoch}:${quote}`;
  if (!remember(`${symbol}:${uid}`)) return;
  if (queue.length >= MAX_QUEUE) throw new Error("Research archive queue reached its hard memory limit");
  queue.push({ symbol, epoch, quote, pip_size: precision, digit, tick_uid: uid, source });
  lastTickAt = Date.now(); totalTicks++;
  if (queue.length >= FLUSH_COUNT) void flush();
}
async function persistBatch(batch) {
  if (!batch.length) return;
  const byDay = new Map();
  for (const tick of batch) {
    const day = utcDay(tick.epoch);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(JSON.stringify(tick));
  }
  await mkdir(ARCHIVE_DIR, { recursive: true, mode: 0o700 });
  for (const [day, lines] of byDay) {
    const path = `${ARCHIVE_DIR}/ticks-${day}.jsonl.gz`;
    // Each append is a complete gzip member; concatenated members remain a valid gzip stream.
    await appendFile(path, gzipSync(Buffer.from(lines.join("\n") + "\n"), { level: 6 }), { mode: 0o600 });
  }
  const grouped = new Map();
  for (const tick of batch) {
    const key = `${utcDay(tick.epoch)}|${tick.symbol}`;
    if (!grouped.has(key)) grouped.set(key, { day: utcDay(tick.epoch), symbol: tick.symbol, count: 0, digits: Array(10).fill(0), first: tick.epoch, last: tick.epoch });
    const g = grouped.get(key); g.count++; g.digits[tick.digit]++; g.first = Math.min(g.first, tick.epoch); g.last = Math.max(g.last, tick.epoch);
  }
  for (const g of grouped.values()) {
    await sql`INSERT INTO public.ddpe_research_daily (owner_id, trading_day, symbol, tick_count, digit_counts, first_tick_epoch, last_tick_epoch, updated_at)
      VALUES (${OWNER}, ${g.day}::date, ${g.symbol}, ${g.count}, ${JSON.stringify(g.digits)}::jsonb, ${g.first}, ${g.last}, NOW())
      ON CONFLICT (owner_id, trading_day, symbol) DO UPDATE SET
      tick_count = public.ddpe_research_daily.tick_count + EXCLUDED.tick_count,
      digit_counts = (SELECT jsonb_agg(to_jsonb((a.value::text::bigint + b.value::text::bigint))) FROM jsonb_array_elements(public.ddpe_research_daily.digit_counts) WITH ORDINALITY a(value,n) JOIN jsonb_array_elements(EXCLUDED.digit_counts) WITH ORDINALITY b(value,n) USING (n)),
      first_tick_epoch = LEAST(public.ddpe_research_daily.first_tick_epoch, EXCLUDED.first_tick_epoch),
      last_tick_epoch = GREATEST(public.ddpe_research_daily.last_tick_epoch, EXCLUDED.last_tick_epoch), updated_at = NOW()`;
  }
}
async function flush() {
  if (flushing || !queue.length) return;
  flushing = true;
  let batch = [];
  try {
    while (queue.length) {
      batch = queue.splice(0, FLUSH_COUNT);
      await persistBatch(batch);
      batch = [];
    }
  } catch (error) {
    if (batch.length) queue.unshift(...batch);
    throw error;
  } finally { flushing = false; }
}
async function writeHealth(state, error = null) {
  await sql`INSERT INTO public.ddpe_research_worker (owner_id, instance_id, state, connected_at, last_tick_at, total_ticks, subscribed_symbols, reconnect_count, last_error, heartbeat_at)
    VALUES (${OWNER}, ${instance}, ${state}, CASE WHEN ${state}='CONNECTED' THEN NOW() ELSE NULL END, ${lastTickAt ? new Date(lastTickAt).toISOString() : null}, ${totalTicks}, ${JSON.stringify([...symbols.keys()])}::jsonb, ${reconnects}, ${error ? String(error).slice(0,500) : null}, NOW())
    ON CONFLICT (owner_id) DO UPDATE SET instance_id=EXCLUDED.instance_id, state=EXCLUDED.state,
    connected_at=CASE WHEN EXCLUDED.state='CONNECTED' THEN NOW() ELSE public.ddpe_research_worker.connected_at END,
    last_tick_at=COALESCE(EXCLUDED.last_tick_at, public.ddpe_research_worker.last_tick_at),
    total_ticks=public.ddpe_research_worker.total_ticks + EXCLUDED.total_ticks,
    subscribed_symbols=EXCLUDED.subscribed_symbols, reconnect_count=EXCLUDED.reconnect_count,
    last_error=EXCLUDED.last_error, heartbeat_at=NOW()`;
  totalTicks = 0;
}
async function requestHistory(symbol) {
  return new Promise((resolve, reject) => {
    const id = reqId++;
    const timer = setTimeout(() => { socket.removeEventListener("message", onMessage); reject(new Error("History request timed out")); }, 12000);
    const onMessage = event => {
      let msg; try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (Number(msg.req_id) !== id) return;
      clearTimeout(timer); socket.removeEventListener("message", onMessage);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg);
    };
    socket.addEventListener("message", onMessage);
    send({ ticks_history: symbol, adjust_start_time: 1, count: 1000, end: "latest", style: "ticks", req_id: id });
  });
}
async function connect() {
  socket = new WebSocket(URL);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Public Deriv socket connection timed out")), 15000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Public Deriv socket failed")); }, { once: true });
  });
  socket.addEventListener("message", event => {
    let msg; try { msg = JSON.parse(String(event.data)); } catch { return; }
    if (msg.error) { console.error("[research] Deriv error", msg.error.message); return; }
    if (msg.msg_type === "active_symbols") {
      // Only synthetic indices; do not ingest forex, commodities, crypto or Crash/Boom products.
      const allowed = (msg.active_symbols || []).filter(item =>
        item.market === "synthetic_index" && item.underlying_symbol &&
        !/boom|crash/i.test(`${item.underlying_symbol} ${item.underlying_symbol_name || ""}`));
      symbols = new Map(allowed.map(item => [item.underlying_symbol, { pipSize: normalizePipSize(item.pip_size) }]));
      for (const symbol of symbols.keys()) send({ ticks: symbol, subscribe: 1 });
      void writeHealth("CONNECTED");
    } else if (msg.msg_type === "tick" && msg.tick) {
      const symbol = String(msg.tick.symbol || "");
      if (symbols.has(symbol)) {
        try { acceptTick(msg.tick); } catch (error) { console.error("[research] tick queue:", error.message); socket.close(); }
      }
    } else if (msg.msg_type === "ping") { /* heartbeat ack */ }
  });
  socket.addEventListener("close", () => { if (!stopping) console.warn("[research] Deriv socket closed"); });
  send({ active_symbols: "brief" });
  heartbeatTimer = setInterval(() => { try { send({ ping: 1 }); } catch {} }, 25000);
  // Backfill last 1,000 ticks on reconnect. The archive deduper handles overlap.
  await sleep(1200);
  for (const symbol of symbols.keys()) {
    if (stopping) break;
    try {
      const history = await requestHistory(symbol);
      const prices = history.history?.prices || [], times = history.history?.times || [];
      const precision = normalizePipSize(history.pip_size, prices.at(-1));
      if (precision !== undefined) symbols.set(symbol, { pipSize: precision });
      for (let i = 0; i < prices.length; i++) acceptTick({ symbol, quote: prices[i], epoch: times[i], pip_size: precision }, "backfill");
    } catch (error) { console.warn("[research] backfill failed", symbol, error.message); }
    await sleep(150);
  }
}
async function pruneArchives() {
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  for (const name of await readdir(ARCHIVE_DIR).catch(() => [])) {
    const match = /^ticks-(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/.exec(name);
    if (match && Date.parse(match[1] + "T00:00:00Z") < cutoff) await unlink(`${ARCHIVE_DIR}/${name}`);
  }
}
async function main() {
  await mkdir(ARCHIVE_DIR, { recursive: true, mode: 0o700 });
  await pruneArchives();
  flushTimer = setInterval(() => { flush().catch(error => console.error("[research] flush failed", error)); }, 5000);
  while (!stopping) {
    try {
      await writeHealth("CONNECTING");
      await connect();
      reconnects = 0;
      while (!stopping && socket?.readyState === WebSocket.OPEN) {
        await sleep(1000);
        if (queue.length) await flush();
        if (lastTickAt && Date.now() - lastTickAt > 90000) throw new Error("Market feed stale for 90 seconds");
      }
    } catch (error) {
      reconnects++;
      console.error("[research] reconnect", error.message);
      await writeHealth("DEGRADED", error.message).catch(() => {});
    } finally {
      clearInterval(heartbeatTimer); heartbeatTimer = undefined;
      try { socket?.close(); } catch {}
      socket = null;
    }
    if (!stopping) await sleep(Math.min(30000, 1000 * 2 ** Math.min(reconnects, 5)));
  }
  clearInterval(flushTimer);
  await flush();
  await writeHealth("STOPPED");
}
process.on("SIGTERM", () => { stopping = true; try { socket?.close(); } catch {} });
process.on("SIGINT", () => { stopping = true; try { socket?.close(); } catch {} });
main().catch(error => { console.error(error); process.exitCode = 1; });
