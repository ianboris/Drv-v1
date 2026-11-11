import { neon } from "@neondatabase/serverless";
import {
  createHmac,
  createHash,
  timingSafeEqual,
  randomBytes,
  createCipheriv,
  createDecipheriv,
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


function derivEncryptionKey() {
  const key = Buffer.from(requiredEnv("DERIV_TOKEN_ENCRYPTION_KEY", 40), "base64url");
  if (key.length !== 32) throw new Error("DERIV_TOKEN_ENCRYPTION_KEY must be a base64url-encoded 32-byte key.");
  return key;
}

function encryptDerivToken(token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64url"), iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
}

function decryptDerivToken(row) {
  const decipher = createDecipheriv("aes-256-gcm", derivEncryptionKey(), Buffer.from(row.token_iv, "base64url"));
  decipher.setAuthTag(Buffer.from(row.token_tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(row.token_ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

async function derivAccounts(token) {
  const response = await fetch("https://api.derivws.com/trading/v1/options/accounts", {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 401 ? "Deriv authorization expired. Reconnect your demo account." : "Deriv account lookup failed.");
  const data = body?.data;
  const accounts = Array.isArray(data) ? data : Array.isArray(data?.accounts) ? data.accounts : [];
  return accounts;
}

function isDerivDemoAccount(account) {
  return account?.account_type === "demo" || account?.account_type === "virtual" || account?.is_virtual === true;
}

async function derivConnection(sql) {
  const rows = await sql`SELECT token_ciphertext, token_iv, token_tag, token_expires_at, selected_demo_account_id
    FROM public.ddpe_deriv_connections WHERE owner_id = ${OWNER_ID} LIMIT 1`;
  return rows[0] || null;
}

async function derivAccessToken(sql) {
  const row = await derivConnection(sql);
  if (!row) return null;
  if (new Date(row.token_expires_at).getTime() <= Date.now() + 30000) return null;
  return decryptDerivToken(row);
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
  const routeOverride = url.searchParams.get("__route");
  const path = routeOverride ? `/${routeOverride}` : (url.pathname.slice(4) || "/");
  const method = request.method.toUpperCase();


  // OAuth callback is state-protected and intentionally does not require the
  // Lotus session cookie: SameSite=Strict cookies are not sent on Deriv's
  // cross-site redirect. The one-time state row binds this callback to a
  // server-generated PKCE verifier.
  if (method === "GET" && path === "/deriv/oauth/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const origin = url.origin;
    const fail = (reason) => Response.redirect(new URL("/?deriv_error=" + encodeURIComponent(reason), origin), 303);
    if (url.searchParams.has("error")) return fail("authorization_cancelled");
    if (!code || !state || code.length > 4096 || state.length > 256) return fail("invalid_callback");
    try {
      const sql = getSql();
      const stateHash = createHash("sha256").update(state).digest("hex");
      const rows = await sql`DELETE FROM public.ddpe_deriv_oauth_states
        WHERE state_hash = ${stateHash} AND expires_at > NOW()
        RETURNING code_verifier`;
      if (!rows[0]) return fail("state_expired_or_invalid");
      const clientId = requiredEnv("DERIV_OAUTH_CLIENT_ID", 3);
      const redirectUri = requiredEnv("DERIV_OAUTH_REDIRECT_URI", 20);
      const tokenResponse = await fetch("https://auth.deriv.com/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: rows[0].code_verifier,
          redirect_uri: redirectUri,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const tokenBody = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok || typeof tokenBody.access_token !== "string" || !Number.isFinite(Number(tokenBody.expires_in))) {
        return fail("token_exchange_failed");
      }
      const encrypted = encryptDerivToken(tokenBody.access_token);
      const expiresAt = new Date(Date.now() + Number(tokenBody.expires_in) * 1000);
      await sql`INSERT INTO public.ddpe_deriv_connections
        (owner_id, token_ciphertext, token_iv, token_tag, token_expires_at, selected_demo_account_id, updated_at)
        VALUES (${OWNER_ID}, ${encrypted.ciphertext}, ${encrypted.iv}, ${encrypted.tag}, ${expiresAt.toISOString()}, NULL, NOW())
        ON CONFLICT (owner_id) DO UPDATE SET token_ciphertext = EXCLUDED.token_ciphertext,
          token_iv = EXCLUDED.token_iv, token_tag = EXCLUDED.token_tag,
          token_expires_at = EXCLUDED.token_expires_at, selected_demo_account_id = NULL, updated_at = NOW()`;
      return Response.redirect(new URL("/?deriv=connected", origin), 303);
    } catch {
      return fail("connection_setup_failed");
    }
  }

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
        to_regclass('public.ddpe_research_decisions') IS NOT NULL AS research_decisions,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ddpe_settings' AND column_name = 'account_currency') AS account_currency,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ddpe_settings' AND column_name = 'take_profit_limit') AS take_profit_limit,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ddpe_ticks' AND column_name = 'tick_uid') AS tick_identity,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ddpe_prediction_choices' AND column_name = 'choice_uid') AS choice_identity`;
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

  if (method === "POST" && path === "/deriv/oauth/start") {
    assertSameOrigin(request);
    try {
      const clientId = requiredEnv("DERIV_OAUTH_CLIENT_ID", 3);
      const redirectUri = requiredEnv("DERIV_OAUTH_REDIRECT_URI", 20);
      const verifier = randomBytes(48).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const state = randomBytes(32).toString("base64url");
      const sql = getSql();
      await sql`DELETE FROM public.ddpe_deriv_oauth_states WHERE expires_at <= NOW()`;
      await sql`INSERT INTO public.ddpe_deriv_oauth_states (state_hash, code_verifier, expires_at)
        VALUES (${createHash("sha256").update(state).digest("hex")}, ${verifier}, NOW() + INTERVAL '10 minutes')`;
      const authUrl = new URL("https://auth.deriv.com/oauth2/auth");
      authUrl.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "trade",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      return json({ authorization_url: authUrl.toString() });
    } catch {
      return json({ error: "Deriv OAuth is not configured. Register the Lotus callback URL and configure its OAuth client ID." }, 503);
    }
  }

  if (method === "GET" && path === "/deriv/demo/status") {
    const sql = getSql();
    const row = await derivConnection(sql);
    const connected = Boolean(row && new Date(row.token_expires_at).getTime() > Date.now());
    return json({ connected, account_id: connected ? row.selected_demo_account_id : null,
      token_expires_at: connected ? row.token_expires_at : null, mode: "DEMO_ONLY" });
  }

  if (method === "GET" && path === "/deriv/demo/accounts") {
    const sql = getSql();
    const token = await derivAccessToken(sql);
    if (!token) return json({ error: "Deriv is not connected or its authorization expired.", reconnect_required: true }, 401);
    try {
      const accounts = await derivAccounts(token);
      const demos = accounts.filter(isDerivDemoAccount).map((account) => ({
        account_id: String(account.account_id || account.id || ""),
        currency: String(account.currency || ""),
        balance: Number.isFinite(Number(account.balance)) ? Number(account.balance) : null,
        account_type: "demo",
      })).filter((account) => account.account_id);
      return json({ accounts: demos, mode: "DEMO_ONLY" });
    } catch (error) {
      return json({ error: error.message || "Could not load Deriv demo accounts." }, 502);
    }
  }

  if (method === "POST" && path === "/deriv/demo/otp") {
    assertSameOrigin(request);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
    const accountId = typeof body?.account_id === "string" ? body.account_id : "";
    if (!accountId || accountId.length > 64) return json({ error: "A valid demo account ID is required." }, 400);
    const sql = getSql();
    const token = await derivAccessToken(sql);
    if (!token) return json({ error: "Deriv is not connected or its authorization expired.", reconnect_required: true }, 401);
    try {
      const accounts = await derivAccounts(token);
      const selected = accounts.find((account) => String(account.account_id || account.id || "") === accountId);
      if (!selected || !isDerivDemoAccount(selected)) return json({ error: "Only verified Deriv demo accounts are allowed." }, 403);
      const response = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(12000),
      });
      const result = await response.json().catch(() => ({}));
      const wsUrl = result?.data?.url;
      if (!response.ok || typeof wsUrl !== "string" || !wsUrl.startsWith("wss://api.derivws.com/trading/v1/options/ws/demo?otp=")) {
        return json({ error: "Deriv did not return a valid demo WebSocket URL." }, 502);
      }
      await sql`UPDATE public.ddpe_deriv_connections SET selected_demo_account_id = ${accountId}, updated_at = NOW() WHERE owner_id = ${OWNER_ID}`;
      return json({ websocket_url: wsUrl, mode: "DEMO_ONLY", account_id: accountId });
    } catch (error) {
      return json({ error: error.message || "Could not open Deriv demo session." }, 502);
    }
  }

  if (method === "POST" && path === "/deriv/demo/disconnect") {
    assertSameOrigin(request);
    const sql = getSql();
    const workerInstalled = await sql`SELECT to_regclass('public.ddpe_bot_control') IS NOT NULL AS installed`;
    if (workerInstalled[0]?.installed) {
      const worker = await sql`SELECT desired_running, in_flight_order_uid, buy_unknown
        FROM public.ddpe_bot_control WHERE owner_id = ${OWNER_ID} LIMIT 1`;
      if (worker[0] && (worker[0].desired_running || worker[0].in_flight_order_uid || worker[0].buy_unknown)) {
        return json({ error: "Stop the server worker and wait for every contract to settle or reconcile before disconnecting Deriv." }, 409);
      }
    }
    await sql`DELETE FROM public.ddpe_deriv_connections WHERE owner_id = ${OWNER_ID}`;
    await sql`DELETE FROM public.ddpe_deriv_oauth_states`;
    return json({ ok: true, connected: false });
  }




  if (method === "POST" && path === "/bot/start") {
    assertSameOrigin(request);
    if (process.env.BOT_ENVIRONMENT !== "staging" || process.env.BOT_MODE !== "plumbing_test") {
      return json({ error: "Server worker start is restricted to BOT_ENVIRONMENT=staging and BOT_MODE=plumbing_test." }, 409);
    }
    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
    const accountId = typeof body?.account_id === "string" ? body.account_id : "";
    const symbol = typeof body?.symbol === "string" ? body.symbol : "";
    if (!accountId || accountId.length > 64 || !/^[A-Za-z0-9_]{1,32}$/.test(symbol)) {
      return json({ error: "A verified demo account ID and valid symbol are required." }, 400);
    }
    const sql = getSql();
    const connection = await derivConnection(sql);
    const token = await derivAccessToken(sql);
    if (!connection || !token || connection.selected_demo_account_id !== accountId) {
      return json({ error: "Select and connect the same Deriv demo account in Settings first." }, 409);
    }
    const accounts = await derivAccounts(token);
    const selected = accounts.find((account) => String(account.account_id || account.id || "") === accountId);
    if (!selected || !isDerivDemoAccount(selected)) return json({ error: "Only verified demo accounts can start the worker." }, 403);
    const rows = await sql`UPDATE public.ddpe_bot_control
      SET worker_epoch = worker_epoch + 1, worker_instance_id = NULL, worker_lease_expires_at = NULL,
          desired_running = true, stop_requested = false, mode = 'PLUMBING_TEST', demo_account_id = ${accountId}, symbol = ${symbol},
          daily_loss_limit = COALESCE((SELECT daily_loss_limit FROM public.ddpe_settings WHERE owner_id = ${OWNER_ID}), daily_loss_limit),
          last_error = NULL,
          updated_at = NOW()
      WHERE owner_id = ${OWNER_ID} AND in_flight_order_uid IS NULL AND buy_unknown = false
      RETURNING worker_epoch, mode, symbol, plumbing_remaining`;
    if (!rows.length) return json({ error: "Cannot start while an order is open or a buy outcome is unknown. Reconcile first." }, 409);
    await sql`INSERT INTO public.ddpe_bot_events
      (event_uid, owner_id, worker_epoch, event_type, mode, payload)
      VALUES (${randomBytes(16).toString("hex")}, ${OWNER_ID}, ${rows[0].worker_epoch},
        'WORKER_STARTED', 'PLUMBING_TEST', ${JSON.stringify({ accountId, symbol })}::jsonb)`;
    return json({ ok: true, worker_epoch: Number(rows[0].worker_epoch), mode: rows[0].mode, symbol: rows[0].symbol });
  }

  if (method === "POST" && path === "/bot/stop") {
    assertSameOrigin(request);
    const sql = getSql();
    const rows = await sql`UPDATE public.ddpe_bot_control
      SET desired_running = false, stop_requested = true, updated_at = NOW()
      WHERE owner_id = ${OWNER_ID}
      RETURNING worker_epoch, mode, in_flight_order_uid, buy_unknown`;
    if (!rows.length) return json({ error: "Worker control schema is not installed." }, 503);
    await sql`INSERT INTO public.ddpe_bot_events
      (event_uid, owner_id, worker_epoch, event_type, mode, payload)
      VALUES (${randomBytes(16).toString("hex")}, ${OWNER_ID}, ${rows[0].worker_epoch},
        'WORKER_STOP_REQUESTED', ${rows[0].mode}, ${JSON.stringify({ inFlight: Boolean(rows[0].in_flight_order_uid), buyUnknown: rows[0].buy_unknown })}::jsonb)`;
    return json({ ok: true, stopped: true, monitoring_open_contract: Boolean(rows[0].in_flight_order_uid), reconciliation_required: Boolean(rows[0].buy_unknown) });
  }

  if (method === "GET" && path === "/bot/status") {
    const sql = getSql();
    const rows = await sql`SELECT worker_epoch, desired_running, stop_requested, mode, demo_account_id,
      symbol, in_flight_order_uid, buy_unknown, buy_unknown_order_uid,
      reconciliation_requested, worker_heartbeat_at, worker_lease_expires_at, daily_loss_limit,
      max_stake_pct, consecutive_loss_limit, consecutive_losses,
      plumbing_remaining, last_error, updated_at
      FROM public.ddpe_bot_control WHERE owner_id = ${OWNER_ID} LIMIT 1`;
    if (!rows.length) return json({ installed: false, running: false });
    const events = await sql`SELECT event_type, worker_epoch, order_uid, deriv_contract_id, payload, created_at
      FROM public.ddpe_bot_events WHERE owner_id = ${OWNER_ID}
      ORDER BY id DESC LIMIT 20`;
    return json({ installed: true, control: rows[0], events });
  }

  if (method === "POST" && path === "/bot/reconcile/confirm-no-purchase") {
    assertSameOrigin(request);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (body?.confirm_no_purchase !== true || reason.length < 10 || reason.length > 500) {
      return json({ error: "Explicit confirmation and a 10–500 character review reason are required." }, 400);
    }
    const sql = getSql();
    const rows = await sql`WITH eligible AS (
      SELECT c.worker_epoch, c.mode, c.buy_unknown_order_uid,
        (SELECT e.id FROM public.ddpe_bot_events e
          WHERE e.owner_id = c.owner_id AND e.order_uid = c.buy_unknown_order_uid
            AND e.event_type = 'RECONCILED'
          ORDER BY e.id DESC LIMIT 1) AS evidence_event_id
      FROM public.ddpe_bot_control c
      WHERE c.owner_id = ${OWNER_ID} AND c.buy_unknown = true
        AND (c.worker_lease_expires_at IS NULL OR c.worker_lease_expires_at <= NOW())
        AND c.stop_requested = true AND c.desired_running = false
        AND c.reconciliation_requested = false
        AND EXISTS (
          SELECT 1 FROM public.ddpe_bot_events evidence
          WHERE evidence.id = (
            SELECT e.id FROM public.ddpe_bot_events e
            WHERE e.owner_id = c.owner_id AND e.order_uid = c.buy_unknown_order_uid
              AND e.event_type = 'RECONCILED'
            ORDER BY e.id DESC LIMIT 1
          )
            AND evidence.payload->>'result' = 'no_matching_purchase_found'
            AND evidence.created_at <= NOW() - INTERVAL '10 seconds'
        )
        AND EXISTS (
          SELECT 1 FROM public.ddpe_bot_events sent
          WHERE sent.owner_id = c.owner_id AND sent.order_uid = c.buy_unknown_order_uid
            AND sent.event_type = 'BUY_SENT'
            AND sent.created_at <= NOW() - INTERVAL '60 seconds'
        )
    ), resolved AS (
      UPDATE public.ddpe_bot_control c
      SET buy_unknown = false, buy_unknown_order_uid = NULL,
          in_flight_order_uid = NULL, reconciliation_requested = false,
          desired_running = false, stop_requested = true,
          worker_instance_id = NULL, worker_lease_expires_at = NULL,
          last_error = NULL, updated_at = NOW()
      FROM eligible e
      WHERE c.owner_id = ${OWNER_ID} AND c.worker_epoch = e.worker_epoch
        AND c.buy_unknown_order_uid = e.buy_unknown_order_uid
        AND c.in_flight_order_uid = e.buy_unknown_order_uid
        AND e.evidence_event_id IS NOT NULL
      RETURNING c.worker_epoch, c.mode, e.buy_unknown_order_uid, e.evidence_event_id
    )
    INSERT INTO public.ddpe_bot_events
      (event_uid, owner_id, worker_epoch, event_type, order_uid, mode, payload)
    SELECT ${randomBytes(16).toString("hex")}, ${OWNER_ID}, worker_epoch,
      'RECONCILED', buy_unknown_order_uid, mode,
      jsonb_build_object('result', 'operator_confirmed_no_purchase',
        'reason', ${reason}, 'operatorConfirmed', true,
        'evidenceEventId', evidence_event_id)
    FROM resolved
    RETURNING worker_epoch, order_uid`;
    if (!rows.length) {
      return json({ error: "No eligible no-purchase reconciliation exists. Wait at least 60 seconds after BUY_SENT, request reconciliation, and review Deriv's statement before confirming." }, 409);
    }
    return json({ ok: true, reconciled: true, result: "operator_confirmed_no_purchase", order_uid: rows[0].order_uid });
  }

  if (method === "POST" && path === "/bot/reconcile") {
    assertSameOrigin(request);
    const sql = getSql();
    const rows = await sql`UPDATE public.ddpe_bot_control
      SET reconciliation_requested = true, updated_at = NOW()
      WHERE owner_id = ${OWNER_ID} AND buy_unknown = true
      RETURNING worker_epoch, mode, buy_unknown_order_uid`;
    if (!rows.length) return json({ error: "There is no unresolved BUY_UNKNOWN state to reconcile." }, 409);
    await sql`INSERT INTO public.ddpe_bot_events
      (event_uid, owner_id, worker_epoch, event_type, mode, order_uid, payload)
      VALUES (${randomBytes(16).toString("hex")}, ${OWNER_ID}, ${rows[0].worker_epoch},
        'RECONCILIATION_REQUESTED', ${rows[0].mode}, ${rows[0].buy_unknown_order_uid},
        '{"operator_requested":true}'::jsonb)`;
    return json({ ok: true, reconciliation_requested: true, order_uid: rows[0].buy_unknown_order_uid });
  }

  if (method === "GET" && path === "/settings") {
    const sql = getSql();
    const rows = await sql`SELECT stake::text, daily_loss_limit::text, take_profit_limit::text, analysis_window, account_currency FROM ddpe_settings WHERE owner_id = ${OWNER_ID} LIMIT 1`;
    const row = rows[0] || { stake: "1", daily_loss_limit: "2", take_profit_limit: "5", analysis_window: 100, account_currency: "" };
    return json({ stake: Number(row.stake), dailyLossLimit: Number(row.daily_loss_limit), takeProfitLimit: Number(row.take_profit_limit), windowSize: Number(row.analysis_window), currency: row.account_currency || "" });
  }

  if (method === "PUT" && path === "/settings") {
    assertSameOrigin(request);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
    const stake = Number(body?.stake);
    const dailyLossLimit = Number(body?.dailyLossLimit);
    const takeProfitLimit = Number(body?.takeProfitLimit);
    const windowSize = Number(body?.windowSize);
    const currency = typeof body?.currency === 'string' ? body.currency.trim().toUpperCase() : '';
    if (currency && !/^[A-Z0-9]{2,20}$/.test(currency)) return json({ error: "Invalid account currency code." }, 400);
    if (!Number.isFinite(stake) || stake <= 0 || stake > 1000 ||
        !Number.isFinite(dailyLossLimit) || dailyLossLimit <= 0 || dailyLossLimit > 10000 ||
        !Number.isFinite(takeProfitLimit) || takeProfitLimit <= 0 || takeProfitLimit > 10000 ||
        !Number.isInteger(windowSize) || windowSize < 50 || windowSize > 5000) {
      return json({ error: "Settings are outside permitted ranges." }, 400);
    }
    const sql = getSql();
    await sql`INSERT INTO ddpe_settings (owner_id, stake, daily_loss_limit, take_profit_limit, analysis_window, account_currency)
      VALUES (${OWNER_ID}, ${stake}, ${dailyLossLimit}, ${takeProfitLimit}, ${windowSize}, ${currency || null})
      ON CONFLICT (owner_id) DO UPDATE SET stake = EXCLUDED.stake,
      daily_loss_limit = EXCLUDED.daily_loss_limit, take_profit_limit = EXCLUDED.take_profit_limit,
      analysis_window = EXCLUDED.analysis_window, account_currency = EXCLUDED.account_currency, updated_at = NOW()`;
    return json({ ok: true, stake, dailyLossLimit, takeProfitLimit, windowSize, currency });
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
      choice.settled_at_epoch <= choice.predicted_at_epoch ||
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

  if (method === "GET" && path === "/research") {
    const sql = getSql();
    const rows = await sql`SELECT decision_uid, symbol, strategy, target_digit, predicted_at_epoch,
      settled_at_epoch, outcome_digit, is_correct, analysis_window, sample_size, empirical_rate, model_version
      FROM public.ddpe_research_decisions
      WHERE owner_id = ${OWNER_ID}
      ORDER BY predicted_at_epoch DESC LIMIT 1000`;
    const summary = await sql`SELECT strategy, COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE settled_at_epoch IS NOT NULL)::int AS settled,
      COUNT(*) FILTER (WHERE is_correct = TRUE)::int AS wins,
      COUNT(*) FILTER (WHERE is_correct = FALSE)::int AS losses
      FROM public.ddpe_research_decisions WHERE owner_id = ${OWNER_ID} GROUP BY strategy`;
    return json({ decisions: rows.map((row) => ({
      id: row.decision_uid, symbol: row.symbol, strategy: row.strategy,
      targetDigit: Number(row.target_digit), predictedEpoch: Number(row.predicted_at_epoch),
      settledEpoch: row.settled_at_epoch == null ? null : Number(row.settled_at_epoch),
      outcomeDigit: row.outcome_digit == null ? null : Number(row.outcome_digit),
      correct: row.is_correct == null ? null : Boolean(row.is_correct),
      analysisWindow: Number(row.analysis_window), sampleSize: Number(row.sample_size),
      empiricalRate: Number(row.empirical_rate), modelVersion: row.model_version
    })), summary: summary.map((row) => ({ strategy: row.strategy, total: Number(row.total),
      settled: Number(row.settled), wins: Number(row.wins), losses: Number(row.losses) })) });
  }

  if (method === "POST" && path === "/research") {
    assertSameOrigin(request);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
    const decisions = Array.isArray(body?.decisions) ? body.decisions : [body];
    if (!decisions.length || decisions.length > 100 || decisions.some((item) =>
      typeof item?.decision_uid !== "string" || item.decision_uid.length < 8 || item.decision_uid.length > 160 ||
      typeof item?.symbol !== "string" || !/^[A-Za-z0-9_]{1,32}$/.test(item.symbol) ||
      !["DIFFERS", "MATCHES", "EVEN", "ODD"].includes(item.strategy) ||
      !Number.isInteger(item.target_digit) || item.target_digit < 0 || item.target_digit > 9 ||
      !Number.isSafeInteger(item.predicted_at_epoch) ||
      (item.settled_at_epoch != null && (!Number.isSafeInteger(item.settled_at_epoch) || item.settled_at_epoch <= item.predicted_at_epoch)) ||
      (item.outcome_digit != null && (!Number.isInteger(item.outcome_digit) || item.outcome_digit < 0 || item.outcome_digit > 9)) ||
      (item.is_correct != null && typeof item.is_correct !== "boolean") ||
      !Number.isInteger(item.analysis_window) || item.analysis_window < 50 || item.analysis_window > 5000 ||
      !Number.isInteger(item.sample_size) || item.sample_size < 0 ||
      !Number.isFinite(item.empirical_rate) || item.empirical_rate < 0 || item.empirical_rate > 1 ||
      typeof item.model_version !== "string" || item.model_version.length > 80 ||
      ((item.settled_at_epoch == null) !== (item.outcome_digit == null)) ||
      ((item.settled_at_epoch == null) !== (item.is_correct == null)))) {
      return json({ error: "Invalid research decision batch." }, 400);
    }
    const sql = getSql();
    await sql`INSERT INTO public.ddpe_research_decisions
      (owner_id, decision_uid, symbol, strategy, target_digit, predicted_at_epoch,
       settled_at_epoch, outcome_digit, is_correct, analysis_window, sample_size, empirical_rate, model_version)
      SELECT ${OWNER_ID}, item.decision_uid, item.symbol, item.strategy, item.target_digit,
        item.predicted_at_epoch, item.settled_at_epoch, item.outcome_digit, item.is_correct,
        item.analysis_window, item.sample_size, item.empirical_rate, item.model_version
      FROM jsonb_to_recordset(${JSON.stringify(decisions)}::jsonb)
      AS item(decision_uid text, symbol text, strategy text, target_digit smallint,
        predicted_at_epoch bigint, settled_at_epoch bigint, outcome_digit smallint,
        is_correct boolean, analysis_window integer, sample_size integer,
        empirical_rate numeric, model_version text)
      ON CONFLICT (owner_id, decision_uid) DO UPDATE SET
        settled_at_epoch = EXCLUDED.settled_at_epoch,
        outcome_digit = EXCLUDED.outcome_digit,
        is_correct = EXCLUDED.is_correct`;
    return json({ ok: true, accepted: decisions.length });
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
