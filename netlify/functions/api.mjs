import { neon } from "@neondatabase/serverless";
import {
  createHmac,
  createHash,
  timingSafeEqual,
  randomBytes,
} from "node:crypto";

const COOKIE_NAME = "ddpe_session";
const SESSION_SECONDS = 8 * 60 * 60;
const OWNER_ID = "primary";

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function requiredEnv(name, minLength = 1) {
  const value = process.env[name];
  if (!value || value.length < minLength) throw new Error(`Missing or weak environment variable: ${name}`);
  return value;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function sign(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verify(token, secret) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expected = createHmac("sha256", secret).update(parts[0]).digest();
  let supplied;
  try { supplied = Buffer.from(parts[1], "base64url"); } catch { return null; }
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (payload.sub !== OWNER_ID || !Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000) return null;
    return payload;
  } catch { return null; }
}

function cookieValue(header, name) {
  const item = (header || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(name + "="));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : "";
}

function assertSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const requestOrigin = new URL(request.url).origin;
  if (origin !== requestOrigin) throw new Error("Cross-origin request rejected");
}

function getSql() {
  return neon(requiredEnv("DATABASE_URL", 20));
}

function getSession(request) {
  const secret = requiredEnv("DDPE_SESSION_SECRET", 32);
  return verify(cookieValue(request.headers.get("cookie"), COOKIE_NAME), secret);
}

function sessionCookie(token, maxAge = SESSION_SECONDS) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function handle(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "").replace(/^\/.netlify\/functions\/api/, "") || "/";
  const method = request.method.toUpperCase();

  if (method === "GET" && path === "/health") {
    const checks = {
      database_configured: Boolean(process.env.DATABASE_URL),
      login_configured: Boolean(process.env.DDPE_LOGIN_PASSWORD && process.env.DDPE_LOGIN_PASSWORD.length >= 16),
      session_secret_configured: Boolean(process.env.DDPE_SESSION_SECRET && process.env.DDPE_SESSION_SECRET.length >= 32),
      database_connected: false,
      schema_ready: false,
    };
    try {
      const sql = getSql();
      await sql`SELECT 1 AS connected`;
      checks.database_connected = true;
      const schema = await sql`SELECT
        to_regclass('public.ddpe_settings') IS NOT NULL AS settings,
        to_regclass('public.ddpe_ticks') IS NOT NULL AS ticks,
        to_regclass('public.ddpe_prediction_choices') IS NOT NULL AS choices,
        to_regclass('public.ddpe_trades') IS NOT NULL AS trades,
        to_regclass('public.ddpe_daily_risk') IS NOT NULL AS daily_risk,
        to_regclass('public.ddpe_login_limits') IS NOT NULL AS login_limits,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ddpe_settings' AND column_name = 'account_currency') AS account_currency`;
      checks.schema_ready = Boolean(schema[0] && Object.values(schema[0]).every(Boolean));
    } catch (error) {
      return json({ ok: false, checks, error: "Database connection failed. Check DATABASE_URL and Neon network access." }, 503);
    }
    const ready = checks.database_connected && checks.schema_ready && checks.login_configured && checks.session_secret_configured;
    return json({ ok: ready, checks }, ready ? 200 : 503);
  }

  if (method === "POST" && path === "/login") {
    assertSameOrigin(request);
    const password = requiredEnv("DDPE_LOGIN_PASSWORD", 16);
    const secret = requiredEnv("DDPE_SESSION_SECRET", 32);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
    const forwarded = request.headers.get("x-real-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const rateKey = createHash("sha256").update(`${forwarded}|${request.headers.get("user-agent") || "unknown"}`).digest("hex");
    const sql = getSql();
    const rateRows = await sql`INSERT INTO ddpe_login_limits (attempt_key, window_started_at, attempts, updated_at)
      VALUES (${rateKey}, NOW(), 1, NOW())
      ON CONFLICT (attempt_key) DO UPDATE SET
        attempts = CASE WHEN ddpe_login_limits.window_started_at < NOW() - INTERVAL '15 minutes'
          THEN 1 ELSE ddpe_login_limits.attempts + 1 END,
        window_started_at = CASE WHEN ddpe_login_limits.window_started_at < NOW() - INTERVAL '15 minutes'
          THEN NOW() ELSE ddpe_login_limits.window_started_at END,
        updated_at = NOW()
      RETURNING attempts`;
    if (Number(rateRows[0]?.attempts || 0) > 10) {
      return json({ error: "Too many login attempts. Try again in 15 minutes." }, 429, { "retry-after": "900" });
    }
    if (!safeEqual(body?.password || "", password)) return json({ error: "Invalid credentials." }, 401);
    await sql`DELETE FROM ddpe_login_limits WHERE attempt_key = ${rateKey}`;
    const now = Math.floor(Date.now() / 1000);
    const token = sign({ sub: OWNER_ID, iat: now, exp: now + SESSION_SECONDS, nonce: randomBytes(12).toString("hex") }, secret);
    return json({ ok: true, expires_in: SESSION_SECONDS }, 200, { "set-cookie": sessionCookie(token) });
  }

  if (method === "POST" && path === "/logout") {
    assertSameOrigin(request);
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }

  const session = getSession(request);
  if (!session) return json({ error: "Authentication required." }, 401);

  if (method === "GET" && path === "/session") return json({ authenticated: true, expires_at: session.exp });

  if (method === "GET" && path === "/settings") {
    const sql = getSql();
    const rows = await sql`SELECT stake::text, daily_loss_limit::text, analysis_window, account_currency FROM ddpe_settings WHERE owner_id = ${OWNER_ID} LIMIT 1`;
    const row = rows[0] || { stake: "1", daily_loss_limit: "2", analysis_window: 100, account_currency: "" };
    return json({ stake: Number(row.stake), dailyLossLimit: Number(row.daily_loss_limit), windowSize: Number(row.analysis_window), currency: row.account_currency || "" });
  }

  if (method === "PUT" && path === "/settings") {
    assertSameOrigin(request);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
    const stake = Number(body?.stake);
    const dailyLossLimit = Number(body?.dailyLossLimit);
    const windowSize = Number(body?.windowSize);
    const currency = typeof body?.currency === 'string' ? body.currency.trim().toUpperCase() : '';
    if (currency && !/^[A-Z0-9]{2,20}$/.test(currency)) return json({ error: "Invalid account currency code." }, 400);
    if (!Number.isFinite(stake) || stake <= 0 || stake > 1000 ||
        !Number.isFinite(dailyLossLimit) || dailyLossLimit <= 0 || dailyLossLimit > 10000 ||
        !Number.isInteger(windowSize) || windowSize < 50 || windowSize > 5000) {
      return json({ error: "Settings are outside permitted ranges." }, 400);
    }
    const sql = getSql();
    await sql`INSERT INTO ddpe_settings (owner_id, stake, daily_loss_limit, analysis_window, account_currency)
      VALUES (${OWNER_ID}, ${stake}, ${dailyLossLimit}, ${windowSize}, ${currency || null})
      ON CONFLICT (owner_id) DO UPDATE SET stake = EXCLUDED.stake,
      daily_loss_limit = EXCLUDED.daily_loss_limit,
      analysis_window = EXCLUDED.analysis_window, account_currency = EXCLUDED.account_currency, updated_at = NOW()`;
    return json({ ok: true, stake, dailyLossLimit, windowSize, currency });
  }

  if (method === "POST" && path === "/ticks") {
    assertSameOrigin(request);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
    const tickRows = Array.isArray(body?.ticks) ? body.ticks : [body];
    if (!tickRows.length || tickRows.length > 100 || tickRows.some((tick) =>
      typeof tick?.tick_uid !== "string" || tick.tick_uid.length < 8 || tick.tick_uid.length > 160 ||
      typeof tick?.symbol !== "string" || !/^[A-Za-z0-9_]{1,32}$/.test(tick.symbol) ||
      !Number.isSafeInteger(tick.epoch) || !Number.isFinite(Number(tick.quote)) ||
      !Number.isInteger(tick.pip_size) || tick.pip_size < 0 || tick.pip_size > 10 ||
      !Number.isInteger(tick.last_digit) || tick.last_digit < 0 || tick.last_digit > 9)) {
      return json({ error: "Invalid tick batch. Each tick needs a stable tick_uid and valid market fields." }, 400);
    }
    const sql = getSql();
    await sql`INSERT INTO ddpe_ticks (owner_id, symbol, tick_uid, tick_epoch, quote, pip_size, last_digit)
      SELECT ${OWNER_ID}, item.symbol, item.tick_uid, item.epoch, item.quote, item.pip_size, item.last_digit
      FROM jsonb_to_recordset(${JSON.stringify(tickRows)}::jsonb)
      AS item(symbol text, tick_uid text, epoch bigint, quote numeric, pip_size smallint, last_digit smallint)
      ON CONFLICT (owner_id, symbol, tick_uid) DO NOTHING`;
    return json({ ok: true, accepted: tickRows.length });
  }

  if (method === "GET" && path === "/choices") {
    const symbol = url.searchParams.get("symbol");
    if (symbol && !/^[A-Za-z0-9_]{1,32}$/.test(symbol)) return json({ error: "Invalid symbol." }, 400);
    const sql = getSql();
    const rows = symbol
      ? await sql`SELECT choice_uid, symbol, barrier_digit, predicted_at_epoch, settled_at_epoch, outcome_digit, is_correct, analysis_window FROM ddpe_prediction_choices WHERE owner_id = ${OWNER_ID} AND symbol = ${symbol} AND is_correct IS NOT NULL ORDER BY settled_at_epoch DESC LIMIT 500`
      : await sql`SELECT choice_uid, symbol, barrier_digit, predicted_at_epoch, settled_at_epoch, outcome_digit, is_correct, analysis_window FROM (SELECT choice_uid, symbol, barrier_digit, predicted_at_epoch, settled_at_epoch, outcome_digit, is_correct, analysis_window, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY settled_at_epoch DESC) AS market_rank FROM ddpe_prediction_choices WHERE owner_id = ${OWNER_ID} AND is_correct IS NOT NULL) ranked WHERE market_rank <= 500 ORDER BY symbol, settled_at_epoch DESC`;
    const aggregateRows = symbol
      ? await sql`SELECT symbol, barrier_digit, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_correct = TRUE)::int AS wins FROM (SELECT symbol, barrier_digit, is_correct, ROW_NUMBER() OVER (PARTITION BY symbol, barrier_digit ORDER BY settled_at_epoch DESC) AS barrier_rank FROM ddpe_prediction_choices WHERE owner_id = ${OWNER_ID} AND symbol = ${symbol} AND is_correct IS NOT NULL) ranked WHERE barrier_rank <= 500 GROUP BY symbol, barrier_digit`
      : await sql`SELECT symbol, barrier_digit, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_correct = TRUE)::int AS wins FROM (SELECT symbol, barrier_digit, is_correct, ROW_NUMBER() OVER (PARTITION BY symbol, barrier_digit ORDER BY settled_at_epoch DESC) AS barrier_rank FROM ddpe_prediction_choices WHERE owner_id = ${OWNER_ID} AND is_correct IS NOT NULL) ranked WHERE barrier_rank <= 500 GROUP BY symbol, barrier_digit`;
    return json({ aggregates: aggregateRows.map((row) => ({ symbol: row.symbol, barrier: Number(row.barrier_digit), total: Number(row.total), wins: Number(row.wins) })), choices: rows.map((row) => ({
      id: row.choice_uid,
      symbol: row.symbol,
      barrier: Number(row.barrier_digit),
      predictedEpoch: Number(row.predicted_at_epoch),
      settledEpoch: Number(row.settled_at_epoch),
      outcomeDigit: Number(row.outcome_digit),
      correct: Boolean(row.is_correct),
      analysisWindow: Number(row.analysis_window),
    })) });
  }

  if (method === "POST" && path === "/choices") {
    assertSameOrigin(request);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
    const choices = Array.isArray(body?.choices) ? body.choices : [body];
    if (!choices.length || choices.length > 100 || choices.some((choice) =>
      typeof choice?.choice_uid !== "string" || choice.choice_uid.length < 8 || choice.choice_uid.length > 160 ||
      typeof choice?.symbol !== "string" || !/^[A-Za-z0-9_]{1,32}$/.test(choice.symbol) ||
      !Number.isInteger(choice.barrier_digit) || choice.barrier_digit < 0 || choice.barrier_digit > 9 ||
      !Number.isSafeInteger(choice.predicted_at_epoch) || !Number.isSafeInteger(choice.settled_at_epoch) ||
      choice.settled_at_epoch < choice.predicted_at_epoch ||
      !Number.isInteger(choice.outcome_digit) || choice.outcome_digit < 0 || choice.outcome_digit > 9 ||
      typeof choice.is_correct !== "boolean" ||
      !Number.isInteger(choice.analysis_window) || choice.analysis_window < 50 || choice.analysis_window > 5000)) {
      return json({ error: "Invalid settled choice batch." }, 400);
    }
    const sql = getSql();
    await sql`INSERT INTO ddpe_prediction_choices
      (owner_id, choice_uid, symbol, barrier_digit, predicted_at_epoch, settled_at_epoch, outcome_digit, is_correct, analysis_window)
      SELECT ${OWNER_ID}, item.choice_uid, item.symbol, item.barrier_digit, item.predicted_at_epoch,
        item.settled_at_epoch, item.outcome_digit, item.is_correct, item.analysis_window
      FROM jsonb_to_recordset(${JSON.stringify(choices)}::jsonb)
      AS item(choice_uid text, symbol text, barrier_digit smallint, predicted_at_epoch bigint,
        settled_at_epoch bigint, outcome_digit smallint, is_correct boolean, analysis_window integer)
      ON CONFLICT (owner_id, choice_uid) DO UPDATE SET
        settled_at_epoch = EXCLUDED.settled_at_epoch,
        outcome_digit = EXCLUDED.outcome_digit,
        is_correct = EXCLUDED.is_correct,
        analysis_window = EXCLUDED.analysis_window`;
    return json({ ok: true, accepted: choices.length });
  }

  return json({ error: "Not found." }, 404);
}

export default async (request) => {
  try {
    return await handle(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Cross-origin request rejected" ? 403 : 503;
    return json({ error: status === 403 ? message : "Backend configuration or service error." }, status);
  }
};
