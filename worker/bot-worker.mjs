import { neon } from "@neondatabase/serverless";
import { createDecipheriv, randomUUID } from "node:crypto";
import { assertRiskAllowed, digitFromQuote, leastFrequentDigit } from "./risk.mjs";

const OWNER_ID = "primary";
const POLL_MS = 1500;
const HISTORY_COUNT = 500;
const WS_TIMEOUT_MS = 12000;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function decryptToken(row) {
  const key = Buffer.from(requiredEnv("DERIV_TOKEN_ENCRYPTION_KEY"), "base64url");
  if (key.length !== 32) throw new Error("Invalid DERIV_TOKEN_ENCRYPTION_KEY.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.token_iv, "base64url"));
  decipher.setAuthTag(Buffer.from(row.token_tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(row.token_ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

async function restJson(url, token, method = "GET") {
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(WS_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Deriv REST request failed (${response.status}).`);
  return body;
}

class DerivSocket {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
  }
  async connect() {
    if (typeof WebSocket !== "function") throw new Error("Node 22 WebSocket support is required.");
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Deriv WebSocket connection timed out.")), WS_TIMEOUT_MS);
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Deriv WebSocket connection failed.")); }, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      const reqId = message.req_id;
      if (reqId && this.pending.has(reqId)) {
        const pending = this.pending.get(reqId);
        this.pending.delete(reqId);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || "Deriv request failed."));
        else pending.resolve(message);
      }
      for (const listener of this.listeners) listener(message);
    });
    this.socket.addEventListener("close", () => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Deriv WebSocket closed."));
        this.pending.delete(id);
      }
    });
  }
  request(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Deriv WebSocket is not open."));
    const req_id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error("Deriv request timed out."));
      }, WS_TIMEOUT_MS);
      this.pending.set(req_id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ ...payload, req_id }));
    });
  }
  addListener(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close() { try { this.socket?.close(); } catch {} }
}

function getSql() { return neon(requiredEnv("DATABASE_URL")); }

async function loadControl(sql) {
  const rows = await sql`SELECT * FROM public.ddpe_bot_control WHERE owner_id = ${OWNER_ID} LIMIT 1`;
  return rows[0] || null;
}

async function fencedEvent(sql, epoch, eventType, orderUid = null, payload = {}, contractId = null) {
  await sql`INSERT INTO public.ddpe_bot_events
    (event_uid, owner_id, worker_epoch, event_type, order_uid, deriv_contract_id, mode, payload)
    SELECT ${randomUUID()}, ${OWNER_ID}, ${epoch}, ${eventType}, ${orderUid},
      ${contractId}, mode, ${JSON.stringify(payload)}::jsonb
    FROM public.ddpe_bot_control
    WHERE owner_id = ${OWNER_ID} AND worker_epoch = ${epoch}`;
}

async function heartbeat(sql, epoch) {
  const rows = await sql`UPDATE public.ddpe_bot_control SET worker_heartbeat_at = NOW(), updated_at = NOW()
    WHERE owner_id = ${OWNER_ID} AND worker_epoch = ${epoch} AND desired_running = true
    RETURNING worker_epoch`;
  if (!rows.length) throw new Error("STALE_WORKER_EPOCH_OR_STOPPED");
  await fencedEvent(sql, epoch, "HEARTBEAT");
}

async function getDerivCredentials(sql) {
  const rows = await sql`SELECT token_ciphertext, token_iv, token_tag, token_expires_at, selected_demo_account_id
    FROM public.ddpe_deriv_connections WHERE owner_id = ${OWNER_ID} LIMIT 1`;
  const row = rows[0];
  if (!row || !row.selected_demo_account_id || new Date(row.token_expires_at).getTime() <= Date.now() + 30000) {
    throw new Error("Deriv demo OAuth connection is missing or expired.");
  }
  return { token: decryptToken(row), accountId: row.selected_demo_account_id };
}

async function openDemoSocket(sql, epoch) {
  const { token, accountId } = await getDerivCredentials(sql);
  const accountsBody = await restJson("https://api.derivws.com/trading/v1/options/accounts", token);
  const accounts = Array.isArray(accountsBody?.data) ? accountsBody.data : (accountsBody?.data?.accounts || []);
  const account = accounts.find((item) => String(item.account_id || item.id || "") === accountId);
  if (!account || !(account.account_type === "demo" || account.account_type === "virtual" || account.is_virtual === true)) {
    throw new Error("Worker refused a non-demo or unverified Deriv account.");
  }
  const otpBody = await restJson(`https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`, token, "POST");
  const wsUrl = otpBody?.data?.url;
  if (typeof wsUrl !== "string" || !wsUrl.startsWith("wss://api.derivws.com/trading/v1/options/ws/demo?otp=")) {
    throw new Error("Deriv did not return a verified demo WebSocket URL.");
  }
  const socket = new DerivSocket(wsUrl);
  await socket.connect();
  await fencedEvent(sql, epoch, "WORKER_STARTED", null, { accountId, execution: "demo_only" });
  return { socket, token, account };
}

async function getDailyRisk(sql, control) {
  const rows = await sql`SELECT realized_net_pl, locked FROM public.ddpe_daily_risk
    WHERE owner_id = ${OWNER_ID} AND trading_day = CURRENT_DATE LIMIT 1`;
  return { netPl: Number(rows[0]?.realized_net_pl || 0), locked: Boolean(rows[0]?.locked) };
}

async function reserveOrder(sql, orderUid, epoch) {
  // The same conditional update both reserves before proposal and revalidates
  // the reservation immediately before buy. It cannot pass after Stop or a fence.
  const rows = await sql`UPDATE public.ddpe_bot_control
    SET in_flight_order_uid = ${orderUid}, updated_at = NOW()
    WHERE owner_id = ${OWNER_ID}
      AND stop_requested = false
      AND buy_unknown = false
      AND worker_epoch = ${epoch}
      AND (in_flight_order_uid IS NULL OR in_flight_order_uid = ${orderUid})
    RETURNING owner_id`;
  return rows.length === 1;
}

async function releaseOrder(sql, orderUid, epoch) {
  await sql`UPDATE public.ddpe_bot_control
    SET in_flight_order_uid = NULL, updated_at = NOW()
    WHERE owner_id = ${OWNER_ID} AND worker_epoch = ${epoch}
      AND in_flight_order_uid = ${orderUid} AND buy_unknown = false`;
}

async function markBuyUnknown(sql, orderUid, epoch, reason) {
  const rows = await sql`UPDATE public.ddpe_bot_control
    SET buy_unknown = true, buy_unknown_order_uid = ${orderUid},
        last_error = ${String(reason).slice(0, 500)}, desired_running = false,
        stop_requested = true, updated_at = NOW()
    WHERE owner_id = ${OWNER_ID} AND worker_epoch = ${epoch}
      AND in_flight_order_uid = ${orderUid}
    RETURNING worker_epoch`;
  if (rows.length) await fencedEvent(sql, epoch, "BUY_UNKNOWN", orderUid, { reason: String(reason).slice(0, 300) });
}

async function settleOrder(sql, epoch, orderUid, contractId, profit, status) {
  const numericProfit = Number(profit);
  if (!Number.isFinite(numericProfit)) throw new Error("Deriv settlement profit is not numeric.");
  await sql`INSERT INTO public.ddpe_daily_risk
    (owner_id, trading_day, realized_net_pl, loss_limit, locked, lock_reason, updated_at)
    VALUES (${OWNER_ID}, CURRENT_DATE, ${numericProfit}, 2, false, NULL, NOW())
    ON CONFLICT (owner_id, trading_day) DO UPDATE SET
      realized_net_pl = public.ddpe_daily_risk.realized_net_pl + EXCLUDED.realized_net_pl,
      updated_at = NOW()`;
  await fencedEvent(sql, epoch, "CONTRACT_SETTLED", orderUid, { profit: numericProfit, status }, contractId);
  const controlRows = await sql`UPDATE public.ddpe_bot_control
    SET consecutive_losses = CASE WHEN ${numericProfit} < 0 THEN consecutive_losses + 1 ELSE 0 END,
        in_flight_order_uid = NULL, updated_at = NOW()
    WHERE owner_id = ${OWNER_ID} AND worker_epoch = ${epoch}
      AND in_flight_order_uid = ${orderUid} AND buy_unknown = false
    RETURNING worker_epoch`;
  if (controlRows.length !== 1) throw new Error("Stale epoch while applying settlement.");
  await fencedEvent(sql, epoch, "ORDER_RELEASED", orderUid, { reason: "settled" }, contractId);
}

async function runOneCycle(sql, socket, epoch, control, account) {
  if (!control.symbol || !/^[A-Za-z0-9_]{1,32}$/.test(control.symbol)) throw new Error("Set LOTUS_WORKER_SYMBOL in the staging worker environment.");
  const historyResponse = await socket.request({
    ticks_history: control.symbol, adjust_start_time: 1, count: HISTORY_COUNT, end: "latest", style: "ticks",
  });
  const prices = historyResponse.history?.prices || [];
  const pipSize = Number(historyResponse.pip_size);
  if (prices.length < 100 || !Number.isInteger(pipSize) || pipSize < 0 || pipSize > 10) return;
  const digits = prices.map((price) => digitFromQuote(price, pipSize));
  const barrier = leastFrequentDigit(digits.slice(-100));
  const orderUid = randomUUID();
  if (!(await reserveOrder(sql, orderUid, epoch))) return;
  await fencedEvent(sql, epoch, "ORDER_RESERVED", orderUid, { symbol: control.symbol, barrier });

  let buyWasSent = false;
  try {
    const settingsRows = await sql`SELECT stake, daily_loss_limit FROM public.ddpe_settings WHERE owner_id = ${OWNER_ID} LIMIT 1`;
    const requestedStake = Number(settingsRows[0]?.stake || 0.35);
    const dailyLossLimit = Number(settingsRows[0]?.daily_loss_limit || control.daily_loss_limit);
    const daily = await getDailyRisk(sql, control);
    if (daily.locked || daily.netPl <= -dailyLossLimit) throw new Error("DAILY_LOSS_LIMIT_REACHED");
    const balance = Number(account.balance);
    const stake = Math.min(requestedStake, balance * Number(control.max_stake_pct));
    if (!(stake > 0)) throw new Error("Stake is zero after balance-percentage cap.");

    const proposal = await socket.request({
      proposal: 1, amount: stake, basis: "stake", contract_type: "DIGITDIFF",
      currency: account.currency, duration: 1, duration_unit: "t",
      symbol: control.symbol, barrier: String(barrier),
    });
    const quote = proposal.proposal;
    if (!quote?.id || !Number.isFinite(Number(quote.ask_price)) || !Number.isFinite(Number(quote.payout))) {
      throw new Error("Deriv proposal response is incomplete.");
    }
    await fencedEvent(sql, epoch, "PROPOSAL_RECEIVED", orderUid, {
      proposalId: quote.id, askPrice: quote.ask_price, payout: quote.payout,
      grossPayout: quote.payout, stake, barrier, symbol: control.symbol,
    });

    // Recheck stop, epoch, and the same reservation immediately before buy.
    if (!(await reserveOrder(sql, orderUid, epoch))) throw new Error("STOP_OR_FENCE_BLOCKED_BUY");
    const beforeBuy = await loadControl(sql);
    if (!beforeBuy || beforeBuy.stop_requested || beforeBuy.buy_unknown || Number(beforeBuy.worker_epoch) !== epoch) {
      throw new Error("STOP_OR_FENCE_BLOCKED_BUY");
    }
    if (beforeBuy.mode === "PLUMBING_TEST") {
      const cap = await sql`UPDATE public.ddpe_bot_control
        SET plumbing_remaining = plumbing_remaining - 1, updated_at = NOW()
        WHERE owner_id = ${OWNER_ID} AND worker_epoch = ${epoch}
          AND in_flight_order_uid = ${orderUid} AND stop_requested = false
          AND buy_unknown = false AND plumbing_remaining > 0
        RETURNING plumbing_remaining`;
      if (!cap.length) throw new Error("PLUMBING_TRADE_CAP_REACHED");
    }
    await fencedEvent(sql, epoch, "BUY_AUTHORIZED", orderUid, { stake, barrier });
    await fencedEvent(sql, epoch, "BUY_SENT", orderUid, { proposalId: quote.id, stake });
    buyWasSent = true;
    let buy;
    try {
      buy = await socket.request({ buy: quote.id, price: Number(quote.ask_price) });
    } catch (error) {
      await markBuyUnknown(sql, orderUid, epoch, error.message);
      throw error;
    }
    const contractId = Number(buy.buy?.contract_id);
    if (!Number.isSafeInteger(contractId) || contractId <= 0) {
      await markBuyUnknown(sql, orderUid, epoch, "Buy response lacked a valid contract_id.");
      throw new Error("BUY_UNKNOWN_REQUIRES_RECONCILIATION");
    }
    await fencedEvent(sql, epoch, "BUY_CONFIRMED", orderUid, { buyPrice: buy.buy.buy_price, transactionId: buy.buy.transaction_id }, contractId);

    const contract = await socket.request({ proposal_open_contract: 1, contract_id: contractId });
    const poc = contract.proposal_open_contract;
    if (poc?.is_expired === 1 || ["won", "lost", "sold", "cancelled"].includes(poc?.status)) {
      await settleOrder(sql, epoch, orderUid, contractId, poc.profit, poc.status);
    } else {
      // A contract still open is not retried or released. Restart recovery and
      // explicit reconciliation own this slot; the next process must monitor it.
      await sql`UPDATE public.ddpe_bot_control SET desired_running = false, stop_requested = true,
        last_error = 'OPEN_CONTRACT_RECOVERY_REQUIRED', updated_at = NOW()
        WHERE owner_id = ${OWNER_ID} AND worker_epoch = ${epoch} AND in_flight_order_uid = ${orderUid}`;
    }
  } catch (error) {
    if (!buyWasSent) await releaseOrder(sql, orderUid, epoch);
    throw error;
  }
}

async function runWorker() {
  if (process.env.BOT_ENVIRONMENT !== "staging") throw new Error("Worker refuses to run unless BOT_ENVIRONMENT=staging.");
  if (process.env.BOT_MODE !== "plumbing_test") throw new Error("Worker refuses to run unless BOT_MODE=plumbing_test.");
  const sql = getSql();
  let activeEpoch = null;
  let socket = null;
  while (true) {
    try {
      const control = await loadControl(sql);
      if (!control || !control.desired_running || control.stop_requested) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        continue;
      }
      const epoch = Number(control.worker_epoch);
      if (activeEpoch !== epoch) {
        socket?.close();
        const opened = await openDemoSocket(sql, epoch);
        socket = opened.socket;
        activeEpoch = epoch;
      }
      if (control.buy_unknown || control.in_flight_order_uid) {
        await heartbeat(sql, epoch);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        continue;
      }
      await heartbeat(sql, epoch);
      const accountsBody = await restJson("https://api.derivws.com/trading/v1/options/accounts", (await getDerivCredentials(sql)).token);
      const accounts = Array.isArray(accountsBody?.data) ? accountsBody.data : (accountsBody?.data?.accounts || []);
      const account = accounts.find((item) => String(item.account_id || item.id || "") === control.demo_account_id);
      if (!account || !(account.account_type === "demo" || account.account_type === "virtual" || account.is_virtual === true)) {
        throw new Error("Selected Deriv account is not verified demo.");
      }
      assertRiskAllowed({
        stopRequested: control.stop_requested, buyUnknown: control.buy_unknown,
        workerEpoch: epoch, currentEpoch: Number(control.worker_epoch),
        inFlightOrderUid: control.in_flight_order_uid, orderUid: null,
        balance: Number(account.balance), stake: Math.min(Number(control.max_stake_pct) * Number(account.balance), 1),
        maxStakePct: Number(control.max_stake_pct),
        dailyNetPl: 0, dailyLossLimit: Number(control.daily_loss_limit),
        consecutiveLosses: Number(control.consecutive_losses),
        consecutiveLossLimit: Number(control.consecutive_loss_limit),
        mode: control.mode, plumbingRemaining: Number(control.plumbing_remaining),
      });
      await runOneCycle(sql, socket, epoch, control, account);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Worker error";
      if (activeEpoch !== null) {
        try {
          await sql`UPDATE public.ddpe_bot_control SET last_error = ${message.slice(0, 500)},
            desired_running = false, stop_requested = true, updated_at = NOW()
            WHERE owner_id = ${OWNER_ID} AND worker_epoch = ${activeEpoch}`;
          await fencedEvent(sql, activeEpoch, "WORKER_ERROR", null, { error: message.slice(0, 300) });
        } catch {}
      }
      socket?.close();
      socket = null;
      activeEpoch = null;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
}

runWorker().catch((error) => {
  process.stderr.write(`Lotus worker stopped: ${error.message}\n`);
  process.exitCode = 1;
});
