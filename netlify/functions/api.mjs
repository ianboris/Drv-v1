import { neon } from "@neondatabase/serverless";
import {
  createHmac,
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
    };
    try {
      await getSql()`SELECT 1 AS connected`;
      checks.database_connected = true;
    } catch (error) {
      return json({ ok: false, checks, error: "Database connection failed. Check DATABASE_URL and Neon network access." }, 503);
    }
    const ready = checks.login_configured && checks.session_secret_configured;
    return json({ ok: ready, checks }, ready ? 200 : 503);
  }

  if (method === "POST" && path === "/login") {
    assertSameOrigin(request);
    const password = requiredEnv("DDPE_LOGIN_PASSWORD", 16);
    const secret = requiredEnv("DDPE_SESSION_SECRET", 32);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
    if (!safeEqual(body?.password || "", password)) return json({ error: "Invalid credentials." }, 401);
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
    const rows = await sql`SELECT stake::text, daily_loss_limit::text, analysis_window FROM ddpe_settings WHERE owner_id = ${OWNER_ID} LIMIT 1`;
    const row = rows[0] || { stake: "1", daily_loss_limit: "2", analysis_window: 100 };
    return json({ stake: Number(row.stake), dailyLossLimit: Number(row.daily_loss_limit), windowSize: Number(row.analysis_window) });
  }

  if (method === "PUT" && path === "/settings") {
    assertSameOrigin(request);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
    const stake = Number(body?.stake);
    const dailyLossLimit = Number(body?.dailyLossLimit);
    const windowSize = Number(body?.windowSize);
    if (!Number.isFinite(stake) || stake <= 0 || stake > 1000 ||
        !Number.isFinite(dailyLossLimit) || dailyLossLimit <= 0 || dailyLossLimit > 10000 ||
        !Number.isInteger(windowSize) || windowSize < 50 || windowSize > 5000) {
      return json({ error: "Settings are outside permitted ranges." }, 400);
    }
    const sql = getSql();
    await sql`INSERT INTO ddpe_settings (owner_id, stake, daily_loss_limit, analysis_window)
      VALUES (${OWNER_ID}, ${stake}, ${dailyLossLimit}, ${windowSize})
      ON CONFLICT (owner_id) DO UPDATE SET stake = EXCLUDED.stake,
      daily_loss_limit = EXCLUDED.daily_loss_limit,
      analysis_window = EXCLUDED.analysis_window, updated_at = NOW()`;
    return json({ ok: true, stake, dailyLossLimit, windowSize });
  }

  if (method === "POST" && path === "/ticks") {
    assertSameOrigin(request);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
    const tickRows = Array.isArray(body?.ticks) ? body.ticks : [body];
    if (!tickRows.length || tickRows.length > 100 || tickRows.some((tick) =>
      typeof tick?.symbol !== "string" || !/^[A-Za-z0-9_]{1,32}$/.test(tick.symbol) ||
      !Number.isSafeInteger(tick.epoch) || !Number.isFinite(Number(tick.quote)) ||
      !Number.isInteger(tick.pipSize) || tick.pipSize < 0 || tick.pipSize > 10 ||
      !Number.isInteger(tick.lastDigit) || tick.lastDigit < 0 || tick.lastDigit > 9)) {
      return json({ error: "Invalid tick batch. Send between 1 and 100 valid ticks." }, 400);
    }
    const sql = getSql();
    await sql`INSERT INTO ddpe_ticks (owner_id, symbol, tick_epoch, quote, pip_size, last_digit)
      SELECT ${OWNER_ID}, item.symbol, item.epoch, item.quote, item."pipSize", item."lastDigit"
      FROM jsonb_to_recordset(${JSON.stringify(tickRows)}::jsonb)
      AS item(symbol text, epoch bigint, quote numeric, "pipSize" smallint, "lastDigit" smallint)
      ON CONFLICT (owner_id, symbol, tick_epoch) DO NOTHING`;
    return json({ ok: true, accepted: tickRows.length });
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
