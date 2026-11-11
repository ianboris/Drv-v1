import { neon } from "@neondatabase/serverless";
import { mkdir, statfs } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { digitFromQuote, normalizePipSize } from "../src/market-data.mjs";
import { writeBatchSegment, readBatchSegment, listBatchSegments } from "./research-batch-store.mjs";

const URL = "wss://api.derivws.com/trading/v1/options/ws/public";
const OWNER = "primary";
const ARCHIVE_DIR = process.env.LOTUS_ARCHIVE_DIR || "/var/lib/lotus/research";
const MAX_QUEUE = 25000;
const FLUSH_COUNT = 500;
const MAX_SYMBOLS = Math.min(20, Math.max(1, Number(process.env.LOTUS_RESEARCH_MAX_SYMBOLS || 10)));
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const DATABASE_URL = process.env.NEON_STAGING_DATABASE_URL;
if (!DATABASE_URL || DATABASE_URL.length < 20) {
  throw new Error("NEON_STAGING_DATABASE_URL is required; refusing to start without an explicit staging database.");
}
const sql = neon(DATABASE_URL);
const instance = randomUUID();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const utcDay = epoch => new Date(epoch * 1000).toISOString().slice(0, 10);

let socket, reqId = 1, queue = [], symbols = new Map(), seen = new Set();
let flushing = false, stopping = false, reconnects = 0, totalTicks = 0;
let lastTickAt = null, heartbeatTimer, flushTimer, healthTimer;

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Deriv WebSocket is not open");
  socket.send(JSON.stringify({...payload, req_id: payload.req_id ?? reqId++}));
}
function acceptTick(tick, source = "live") {
  const symbol = String(tick?.symbol || "");
  const quote = Number(tick?.quote), epoch = Number(tick?.epoch);
  const precision = normalizePipSize(tick?.pip_size, quote) ?? symbols.get(symbol)?.pipSize;
  if (!symbol || !Number.isFinite(quote) || !Number.isSafeInteger(epoch) || precision === undefined) return;
  const providerId = tick.id == null ? "" : String(tick.id);
  const tickUid = providerId || `${symbol}:${epoch}:${quote}`;
  const key = `${symbol}:${tickUid}`;
  if (seen.has(key)) return;
  if (queue.length >= MAX_QUEUE) throw new Error("Research queue reached its hard memory limit");
  seen.add(key);
  if (seen.size > 100000) seen = new Set([...seen].slice(-50000));
  queue.push({symbol, epoch, quote: String(tick.quote), pip_size: precision,
    digit: digitFromQuote(quote, precision), tick_uid: tickUid, source});
  lastTickAt = Date.now();
  totalTicks++;
  if (queue.length >= FLUSH_COUNT) void flush().catch(error => console.error("[research] flush:", error.message));
}

function dailyGroups(ticks) {
  const groups = new Map();
  for (const tick of ticks) {
    const day = utcDay(tick.epoch), key = `${day}|${tick.symbol}`;
    if (!groups.has(key)) groups.set(key, {day, symbol:tick.symbol, count:0,
      digits:Array(10).fill(0), first:tick.epoch, last:tick.epoch});
    const group = groups.get(key);
    group.count++;
    group.digits[tick.digit]++;
    group.first = Math.min(group.first, tick.epoch);
    group.last = Math.max(group.last, tick.epoch);
  }
  return [...groups.values()].map(g => ({
    day:g.day, symbol:g.symbol, tick_count:g.count, digit_counts:g.digits,
    first_tick_epoch:g.first, last_tick_epoch:g.last
  }));
}

async function commitBatch(batch) {
  const groups = dailyGroups(batch.ticks);
  // One PostgreSQL statement: ledger insertion and daily aggregation commit atomically.
  // If the batch ID already exists, accepted is empty and no aggregate is incremented.
  await sql`
    WITH accepted AS (
      INSERT INTO public.ddpe_research_batches
        (batch_id, checksum, archive_file, tick_count, first_tick_epoch, last_tick_epoch)
      VALUES
        (${batch.batchId}, ${batch.checksum}, ${batch.path}, ${batch.ticks.length},
         ${Math.min(...batch.ticks.map(t => t.epoch))}, ${Math.max(...batch.ticks.map(t => t.epoch))})
      ON CONFLICT (batch_id) DO NOTHING
      RETURNING batch_id
    ),
    tick_input AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(batch.ticks)}::jsonb) AS x(
        symbol text, epoch bigint, digit integer, tick_uid text
      )
    ),
    inserted_ticks AS (
      INSERT INTO public.ddpe_research_tick_ids (symbol, tick_uid)
      SELECT i.symbol, i.tick_uid FROM tick_input i CROSS JOIN accepted
      ON CONFLICT (symbol, tick_uid) DO NOTHING
      RETURNING symbol, tick_uid
    ),
    accepted_daily AS (
      SELECT (to_timestamp(i.epoch) AT TIME ZONE 'UTC')::date AS day,
             i.symbol, i.epoch, i.digit
      FROM tick_input i
      JOIN inserted_ticks n USING (symbol, tick_uid)
    ),
    daily_input AS (
      SELECT day, symbol, COUNT(*) AS tick_count,
        jsonb_build_array(
          COUNT(*) FILTER (WHERE digit=0), COUNT(*) FILTER (WHERE digit=1),
          COUNT(*) FILTER (WHERE digit=2), COUNT(*) FILTER (WHERE digit=3),
          COUNT(*) FILTER (WHERE digit=4), COUNT(*) FILTER (WHERE digit=5),
          COUNT(*) FILTER (WHERE digit=6), COUNT(*) FILTER (WHERE digit=7),
          COUNT(*) FILTER (WHERE digit=8), COUNT(*) FILTER (WHERE digit=9)
        ) AS digit_counts,
        MIN(epoch) AS first_tick_epoch, MAX(epoch) AS last_tick_epoch
      FROM accepted_daily
      GROUP BY day, symbol
    ),
    daily_upsert AS (
      INSERT INTO public.ddpe_research_daily
        (owner_id, trading_day, symbol, tick_count, digit_counts, first_tick_epoch, last_tick_epoch, updated_at)
      SELECT ${OWNER}, d.day, d.symbol, d.tick_count, d.digit_counts,
             d.first_tick_epoch, d.last_tick_epoch, NOW()
      FROM daily_input d
      ON CONFLICT (owner_id, trading_day, symbol) DO UPDATE SET
        tick_count = public.ddpe_research_daily.tick_count + EXCLUDED.tick_count,
        digit_counts = (
          SELECT jsonb_agg(to_jsonb(a.value::bigint + b.value::bigint) ORDER BY a.n)
          FROM jsonb_array_elements(public.ddpe_research_daily.digit_counts)
            WITH ORDINALITY a(value,n)
          JOIN jsonb_array_elements(EXCLUDED.digit_counts)
            WITH ORDINALITY b(value,n) USING (n)
        ),
        first_tick_epoch = LEAST(public.ddpe_research_daily.first_tick_epoch, EXCLUDED.first_tick_epoch),
        last_tick_epoch = GREATEST(public.ddpe_research_daily.last_tick_epoch, EXCLUDED.last_tick_epoch),
        updated_at = NOW()
      RETURNING symbol
    )
    SELECT batch_id FROM accepted
  `;
}

async function persistTicks(ticks) {
  if (!ticks.length) return;
  const disk = await statfs(ARCHIVE_DIR);
  if (Number(disk.bavail) * Number(disk.bsize) < MIN_FREE_BYTES) {
    throw new Error("Archive paused: less than 2 GiB free disk space");
  }
  const segment = await writeBatchSegment(ARCHIVE_DIR, ticks);
  await commitBatch(segment);
}

async function flush() {
  if (flushing || !queue.length) return;
  flushing = true;
  try {
    while (queue.length) {
      const batch = queue.splice(0, FLUSH_COUNT);
      try { await persistTicks(batch); }
      catch (error) { queue.unshift(...batch); throw error; }
    }
  } finally { flushing = false; }
}

async function recoverArchive() {
  const segments = await listBatchSegments(ARCHIVE_DIR);
  let recovered = 0;
  for (const file of segments) {
    const batch = await readBatchSegment(file);
    await commitBatch(batch);
    recovered++;
  }
  console.log(`[research] archive reconciliation complete: ${recovered} immutable segments checked`);
}

async function writeHealth(state, error = null) {
  await sql`
    INSERT INTO public.ddpe_research_worker
      (owner_id, instance_id, state, connected_at, last_tick_at, total_ticks,
       subscribed_symbols, reconnect_count, last_error, heartbeat_at)
    VALUES (${OWNER}, ${instance}, ${state},
      CASE WHEN ${state}='CONNECTED' THEN NOW() ELSE NULL END,
      ${lastTickAt ? new Date(lastTickAt).toISOString() : null},
      ${totalTicks}, ${JSON.stringify([...symbols.keys()])}::jsonb,
      ${reconnects}, ${error ? String(error).slice(0,500) : null}, NOW())
    ON CONFLICT (owner_id) DO UPDATE SET
      instance_id=EXCLUDED.instance_id, state=EXCLUDED.state,
      connected_at=CASE WHEN EXCLUDED.state='CONNECTED' THEN NOW()
        ELSE public.ddpe_research_worker.connected_at END,
      last_tick_at=COALESCE(EXCLUDED.last_tick_at, public.ddpe_research_worker.last_tick_at),
      total_ticks=public.ddpe_research_worker.total_ticks + EXCLUDED.total_ticks,
      subscribed_symbols=EXCLUDED.subscribed_symbols,
      reconnect_count=EXCLUDED.reconnect_count, last_error=EXCLUDED.last_error,
      heartbeat_at=NOW()
  `;
  totalTicks = 0;
}

function requestHistory(symbol) {
  return new Promise((resolve, reject) => {
    const id = reqId++;
    const timer = setTimeout(() => {
      socket?.removeEventListener("message", onMessage);
      reject(new Error("History request timed out"));
    }, 12000);
    const onMessage = event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (Number(message.req_id) !== id) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message);
    };
    socket.addEventListener("message", onMessage);
    send({ticks_history:symbol, adjust_start_time:1, count:1000, end:"latest", style:"ticks", req_id:id});
  });
}

async function connect() {
  socket = new WebSocket(URL);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Deriv connection timed out")), 15000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, {once:true});
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Deriv WebSocket failed")); }, {once:true});
  });
  socket.addEventListener("message", event => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.error) { console.warn("[research] Deriv response error:", message.error.message); return; }
    if (message.msg_type === "active_symbols") {
      const allowed = (message.active_symbols || []).filter(item =>
        item.market === "synthetic_index" && item.underlying_symbol &&
        !/boom|crash/i.test(`${item.underlying_symbol} ${item.underlying_symbol_name || ""}`));
      symbols = new Map(allowed.slice(0, MAX_SYMBOLS).map(item =>
        [item.underlying_symbol, {pipSize:normalizePipSize(item.pip_size)}]));
      for (const symbol of symbols.keys()) send({ticks:symbol, subscribe:1});
      void writeHealth("CONNECTED").catch(error => console.error("[research] health:", error.message));
    } else if (message.msg_type === "tick" && message.tick) {
      if (symbols.has(String(message.tick.symbol || ""))) {
        try { acceptTick(message.tick); }
        catch (error) { console.error("[research] queue:", error.message); socket.close(); }
      }
    }
  });
  socket.addEventListener("close", () => { if (!stopping) console.warn("[research] Deriv socket closed"); });
  send({active_symbols:"brief"});
  heartbeatTimer = setInterval(() => { try { send({ping:1}); } catch {} }, 25000);
  await sleep(1200);
  for (const symbol of symbols.keys()) {
    if (stopping) break;
    try {
      const history = await requestHistory(symbol);
      const prices = history.history?.prices || [], times = history.history?.times || [];
      const precision = normalizePipSize(history.pip_size, prices.at(-1));
      if (precision !== undefined) symbols.set(symbol, {pipSize:precision});
      for (let i=0; i<prices.length; i++) {
        acceptTick({symbol, quote:prices[i], epoch:times[i], pip_size:precision}, "backfill");
      }
    } catch (error) { console.warn("[research] backfill:", symbol, error.message); }
    await sleep(150);
  }
}

async function main() {
  await mkdir(ARCHIVE_DIR, {recursive:true, mode:0o700});
  await recoverArchive();
  await writeHealth("CONNECTING");
  flushTimer = setInterval(() => flush().catch(error => console.error("[research] flush:", error.message)), 5000);
  healthTimer = setInterval(() => writeHealth(socket?.readyState === WebSocket.OPEN ? "CONNECTED" : "DEGRADED")
    .catch(error => console.error("[research] heartbeat:", error.message)), 15000);
  while (!stopping) {
    try {
      await connect();
      reconnects = 0;
      while (!stopping && socket?.readyState === WebSocket.OPEN) {
        await sleep(1000);
        if (queue.length) await flush();
        if (lastTickAt && Date.now()-lastTickAt > 90000) throw new Error("Market feed stale for 90 seconds");
      }
    } catch (error) {
      reconnects++;
      console.error("[research] reconnect:", error.message);
      await writeHealth("DEGRADED", error.message).catch(() => {});
    } finally {
      clearInterval(heartbeatTimer);
      try { socket?.close(); } catch {}
      socket = null;
    }
    if (!stopping) await sleep(Math.min(30000, 1000 * 2 ** Math.min(reconnects, 5)));
  }
  clearInterval(flushTimer);
  clearInterval(healthTimer);
  await flush();
  await writeHealth("STOPPED");
}

process.on("SIGTERM", () => { stopping = true; try { socket?.close(); } catch {} });
process.on("SIGINT", () => { stopping = true; try { socket?.close(); } catch {} });
main().catch(error => { console.error("[research] fatal:", error); process.exitCode = 1; });
