import { neon } from "@neondatabase/serverless";
import { createDecipheriv, randomUUID } from "node:crypto";
import { assertRiskAllowed, digitFromQuote, leastFrequentDigit } from "./risk.mjs";
import { claimWorkerLease, releaseWorkerLease, reserveOrder } from "./control.mjs";

const OWNER_ID = "primary";
const POLL_MS = 1000;
const WS_TIMEOUT_MS = 12000;
const CONTRACT_POLL_MS = 400;
const INSTANCE_ID = randomUUID();
let lastHeartbeatAt = 0;
let lastLeaseRenewAt = 0;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
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
    decipher.update(Buffer.from(row.token_ciphertext, "base64url")), decipher.final(),
  ]).toString("utf8");
}
async function restJson(url, token, method = "GET") {
  const response = await fetch(url, {
    method, headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(WS_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Deriv REST request failed (${response.status}).`);
  return body;
}

class DerivApiError extends Error { constructor(message) { super(message); this.code = "DERIV_REJECTED"; } }

class DerivSocket {
  constructor(url) { this.url = url; this.socket = null; this.nextId = 1; this.pending = new Map(); this.listeners = new Set(); }
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
        this.pending.delete(reqId); clearTimeout(pending.timer);
        if (message.error) pending.reject(new DerivApiError(message.error.message || "Deriv request rejected."));
        else pending.resolve(message);
      }
      for (const listener of this.listeners) listener(message);
    });
    this.socket.addEventListener("close", () => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer); pending.reject(new Error("Deriv WebSocket closed.")); this.pending.delete(id);
      }
    });
  }
  request(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Deriv WebSocket is not open."));
    const req_id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(req_id); reject(new Error("Deriv request timed out.")); }, WS_TIMEOUT_MS);
      this.pending.set(req_id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ ...payload, req_id }));
    });
  }
  close() { try { this.socket?.close(); } catch {} }
}

const sql = neon(requiredEnv("DATABASE_URL"));
async function loadControl() {
  const rows = await sql`SELECT * FROM public.ddpe_bot_control WHERE owner_id = ${OWNER_ID} LIMIT 1`;
  return rows[0] || null;
}
async function getCredentials() {
  const rows = await sql`SELECT token_ciphertext, token_iv, token_tag, token_expires_at, selected_demo_account_id
    FROM public.ddpe_deriv_connections WHERE owner_id = ${OWNER_ID} LIMIT 1`;
  const row = rows[0];
  if (!row || !row.selected_demo_account_id || new Date(row.token_expires_at).getTime() <= Date.now() + 30000) {
    throw new Error("Deriv demo OAuth connection is missing or expired.");
  }
  return { token: decryptToken(row), accountId: row.selected_demo_account_id };
}
async function openDemoSocket(epoch, expectedAccountId) {
  const { token, accountId } = await getCredentials();
  if (expectedAccountId && accountId !== expectedAccountId) throw new Error("Connected Deriv account changed; refusing worker session.");
  const body = await restJson("https://api.derivws.com/trading/v1/options/accounts", token);
  const accounts = Array.isArray(body?.data) ? body.data : (body?.data?.accounts || []);
  const account = accounts.find((item) => String(item.account_id || item.id || "") === accountId);
  if (!account || !(account.account_type === "demo" || account.account_type === "virtual" || account.is_virtual === true)) {
    throw new Error("Worker refused a non-demo or unverified Deriv account.");
  }
  const otp = await restJson(`https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`, token, "POST");
  const wsUrl = otp?.data?.url;
  if (typeof wsUrl !== "string" || !wsUrl.startsWith("wss://api.derivws.com/trading/v1/options/ws/demo?otp=")) {
    throw new Error("Deriv did not return a verified demo WebSocket URL.");
  }
  const socket = new DerivSocket(wsUrl);
  await socket.connect();
  return { socket, account };
}
async function fencedEvent(epoch, eventType, orderUid = null, payload = {}, contractId = null) {
  const rows = await sql`INSERT INTO public.ddpe_bot_events
    (event_uid, owner_id, worker_epoch, worker_instance_id, event_type, order_uid, deriv_contract_id, mode, payload)
    SELECT ${randomUUID()}, ${OWNER_ID}, ${epoch}, ${INSTANCE_ID}, ${eventType}, ${orderUid},
      ${contractId}, mode, ${JSON.stringify(payload)}::jsonb
    FROM public.ddpe_bot_control
    WHERE owner_id = ${OWNER_ID} AND worker_epoch = ${epoch}
    RETURNING event_uid`;
  if (rows.length !== 1) throw new Error("STALE_WORKER_EPOCH_EVENT_REJECTED");
}
async function heartbeat(epoch) {
  if (Date.now() - lastHeartbeatAt < 10000) return;
  const rows = await sql`UPDATE public.ddpe_bot_control SET worker_heartbeat_at = NOW(), updated_at = NOW()
    WHERE owner_id = ${OWNER_ID} AND worker_epoch = ${epoch}
    RETURNING worker_epoch`;
  if (rows.length !== 1) throw new Error("STALE_WORKER_EPOCH");
  await fencedEvent(epoch, "HEARTBEAT");
  lastHeartbeatAt = Date.now();
}
async function releaseOrder(orderUid, epoch) {
  await sql`UPDATE public.ddpe_bot_control SET in_flight_order_uid = NULL, updated_at = NOW()
    WHERE owner_id = ${OWNER_ID} AND worker_epoch = ${epoch}
      AND worker_instance_id = ${INSTANCE_ID} AND worker_lease_expires_at > NOW()
      AND in_flight_order_uid = ${orderUid} AND buy_unknown = false`;
}
async function markBuyUnknown(orderUid, epoch, reason) {
  const rows = await sql`UPDATE public.ddpe_bot_control
    SET buy_unknown = true, buy_unknown_order_uid = ${orderUid},
        last_error = ${String(reason).slice(0, 500)}, desired_running = false,
        stop_requested = true, reconciliation_requested = false, updated_at = NOW()
    WHERE owner_id = ${OWNER_ID} AND worker_epoch = ${epoch}
      AND worker_instance_id = ${INSTANCE_ID} AND worker_lease_expires_at > NOW()
      AND in_flight_order_uid = ${orderUid}
    RETURNING worker_epoch`;
  if (rows.length) await fencedEvent(epoch, "BUY_UNKNOWN", orderUid, { reason: String(reason).slice(0, 300) });
}
async function settleOrder(orderUid, epoch, contractId, profit, status) {
  const pnl = Number(profit);
  if (!Number.isFinite(pnl) || !["won", "lost", "sold", "cancelled"].includes(status)) {
    throw new Error("Deriv settlement response is incomplete.");
  }
  const rows = await sql`SELECT public.ddpe_apply_bot_settlement(
    ${OWNER_ID}, ${epoch}, ${INSTANCE_ID}, ${orderUid}, ${contractId}, ${pnl}, ${status}
  ) AS applied`;
  if (rows.length !== 1) throw new Error("Settlement transaction returned no result.");
}
async function monitorContract(socket, epoch, orderUid, contractId) {
  while (true) {
    if (!(await ensureLease(epoch))) throw new Error("STALE_WORKER_LEASE");
    const control = await loadControl();
    if (!control || Number(control.worker_epoch) !== epoch || control.worker_instance_id !== INSTANCE_ID) throw new Error("STALE_WORKER_EPOCH_OR_LEASE");
    const result = await socket.request({ proposal_open_contract: 1, contract_id: contractId });
    const poc = result.proposal_open_contract;
    if (!poc) throw new Error("Deriv did not return proposal_open_contract data.");
    if (poc.is_expired === 1 || ["won", "lost", "sold", "cancelled"].includes(poc.status)) {
      await settleOrder(orderUid, epoch, contractId, poc.profit, poc.status);
      return;
    }
    await heartbeat(epoch);
    await sleep(CONTRACT_POLL_MS);
  }
}
async function findConfirmedContract(socket, epoch, orderUid) {
  const sent = await sql`SELECT created_at, payload FROM public.ddpe_bot_events
    WHERE owner_id = ${OWNER_ID} AND worker_epoch = ${epoch}
      AND order_uid = ${orderUid} AND event_type = 'BUY_SENT'
    ORDER BY id DESC LIMIT 1`;
  if (!sent.length) throw new Error("BUY_UNKNOWN has no BUY_SENT journal event.");
  const sentAt = Math.floor(new Date(sent[0].created_at).getTime() / 1000);
  const stake = Number(sent[0].payload?.stake);
  const symbol = String(sent[0].payload?.symbol || "");
  const from = Math.max(0, sentAt - 30);
  const to = Math.floor(Date.now() / 1000) + 5;
  const statement = await socket.request({
    statement: 1, action_type: "buy", date_from: from, date_to: to, description: 1, limit: 999,
  });
  const transactions = statement.statement?.transactions;
  if (!Array.isArray(transactions)) throw new Error("Deriv statement response has no transactions array.");
  const candidates = transactions.filter((tx) => {
    const amountMatches = Number.isFinite(Number(tx.amount)) && Math.abs(Math.abs(Number(tx.amount)) - stake) < 0.0000001;
    const timeMatches = Number(tx.transaction_time) >= from && Number(tx.transaction_time) <= to;
    const description = `${tx.shortcode || ""} ${tx.longcode || ""}`;
    const symbolMatches = symbol && description.includes(symbol);
    const contractTypeMatches = description.includes("DIGITDIFF");
    return tx.action_type === "buy" && amountMatches && timeMatches && symbolMatches &&
      contractTypeMatches && Number.isSafeInteger(Number(tx.contract_id));
  });
  if (candidates.length !== 1) {
    throw new Error(`Deriv statement reconciliation is ambiguous (${candidates.length} matching buy rows); buy remains halted.`);
  }
  const contractId = Number(candidates[0].contract_id);
  await fencedEvent(epoch, "RECONCILED", orderUid, {
    source: "statement", transactionId: candidates[0].transaction_id,
    contractId, result: "purchase_confirmed",
  }, contractId);
  const pocResponse = await socket.request({ proposal_open_contract: 1, contract_id: contractId });
  const poc = pocResponse.proposal_open_contract;
  if (!poc) throw new Error("Statement matched a contract, but Deriv returned no contract status.");
  const control = await loadControl();
  if (!control || Number(control.worker_epoch) !== epoch) throw new Error("STALE_WORKER_EPOCH");
  const rows = await sql`UPDATE public.ddpe_bot_control
    SET buy_unknown = false, buy_unknown_order_uid = NULL, reconciliation_requested = false,
        stop_requested = true, desired_running = false, last_error = NULL, updated_at = NOW()
    WHERE owner_id = ${OWNER_ID} AND worker_epoch = ${epoch}
      AND worker_instance_id = ${INSTANCE_ID} AND worker_lease_expires_at > NOW()
      AND buy_unknown = true AND buy_unknown_order_uid = ${orderUid}
    RETURNING worker_epoch`;
  if (rows.length !== 1) throw new Error("Could not clear reconciled BUY_UNKNOWN state.");
  if (poc.is_expired === 1 || ["won", "lost", "sold", "cancelled"].includes(poc.status)) {
    await settleOrder(orderUid, epoch, contractId, poc.profit, poc.status);
  } else {
    await fencedEvent(epoch, "RECONCILED", orderUid, { contractId, result: "purchase_confirmed_contract_open" }, contractId);
    await monitorContract(socket, epoch, orderUid, contractId);
  }
}
async function recoverOpenOrder(socket, epoch, orderUid) {
  const events = await sql`SELECT event_type, deriv_contract_id FROM public.ddpe_bot_events
    WHERE owner_id = ${OWNER_ID} AND worker_epoch = ${epoch}
      AND order_uid = ${orderUid}
      AND event_type IN ('BUY_CONFIRMED', 'RECONCILED')
      AND deriv_contract_id IS NOT NULL
    ORDER BY id DESC LIMIT 1`;
  const contractId = Number(events[0]?.deriv_contract_id);
  if (Number.isSafeInteger(contractId) && contractId > 0) {
    await monitorContract(socket, epoch, orderUid, contractId);
    return;
  }
  const sent = await sql`SELECT event_uid FROM public.ddpe_bot_events
    WHERE owner_id = ${OWNER_ID} AND worker_epoch = ${epoch}
      AND order_uid = ${orderUid} AND event_type = 'BUY_SENT'
    ORDER BY id DESC LIMIT 1`;
  if (sent.length) {
    await markBuyUnknown(orderUid, epoch, "Worker restarted after BUY_SENT but before a confirmed buy response.");
    return;
  }
  await fencedEvent(epoch, "ORDER_RELEASED", orderUid, { reason: "restart_before_buy_sent" });
  await releaseOrder(orderUid, epoch);
}
async function runOneCycle(socket, epoch, control, account) {
  if (!control.symbol || !/^[A-Za-z0-9_]{1,32}$/.test(control.symbol)) throw new Error("Worker symbol is not configured.");
  const history = await socket.request({
    ticks_history: control.symbol, adjust_start_time: 1, count: 500, end: "latest", style: "ticks",
  });
  const prices = history.history?.prices || [];
  const times = history.history?.times || [];
  const pipSize = Number(history.pip_size);
  if (prices.length < 101 || times.length !== prices.length || !Number.isInteger(pipSize) || pipSize < 0 || pipSize > 10) return;
  const latestTickEpoch = Number(times.at(-1));
  if (!Number.isSafeInteger(latestTickEpoch) || Math.floor(Date.now() / 1000) - latestTickEpoch > 15) return;
  const claimed = await sql`UPDATE public.ddpe_bot_control
    SET last_processed_tick_epoch = ${latestTickEpoch}, updated_at = NOW()
    WHERE owner_id = ${OWNER_ID} AND worker_epoch = ${epoch}
      AND worker_instance_id = ${INSTANCE_ID} AND worker_lease_expires_at > NOW()
      AND desired_running = true AND stop_requested = false
      AND in_flight_order_uid IS NULL AND buy_unknown = false
      AND last_processed_tick_epoch < ${latestTickEpoch}
    RETURNING last_processed_tick_epoch`;
  if (claimed.length !== 1) return;
  const digits = prices.map((price) => digitFromQuote(price, pipSize));
  const barrier = leastFrequentDigit(digits.slice(-101, -1));
  const orderUid = randomUUID();
  if (!(await reserveOrder(sql, orderUid, epoch, INSTANCE_ID))) return;
  await fencedEvent(epoch, "ORDER_RESERVED", orderUid, { symbol: control.symbol, barrier });
  let buySent = false;
  try {
    const settings = await sql`SELECT stake, daily_loss_limit FROM public.ddpe_settings WHERE owner_id = ${OWNER_ID} LIMIT 1`;
    const requestedStake = Number(settings[0]?.stake || 0.35);
    const dailyLossLimit = Number(settings[0]?.daily_loss_limit || control.daily_loss_limit);
    const daily = await sql`SELECT realized_net_pl, locked FROM public.ddpe_daily_risk
      WHERE owner_id = ${OWNER_ID} AND trading_day = CURRENT_DATE LIMIT 1`;
    const dailyNetPl = Number(daily[0]?.realized_net_pl || 0);
    const balance = Number(account.balance);
    const stake = Math.min(requestedStake, balance * Number(control.max_stake_pct));
    assertRiskAllowed({
      stopRequested: false, buyUnknown: false, workerEpoch: epoch,
      currentEpoch: Number(control.worker_epoch), inFlightOrderUid: orderUid, orderUid,
      balance, stake, maxStakePct: Number(control.max_stake_pct),
      dailyNetPl, dailyLossLimit,
      consecutiveLosses: Number(control.consecutive_losses),
      consecutiveLossLimit: Number(control.consecutive_loss_limit),
      mode: control.mode, plumbingRemaining: Number(control.plumbing_remaining),
    });
    if (daily[0]?.locked) throw new Error("DAILY_LOSS_LIMIT_REACHED");
    const proposal = await socket.request({
      proposal: 1, amount: stake, basis: "stake", contract_type: "DIGITDIFF",
      currency: account.currency, duration: 1, duration_unit: "t",
      underlying_symbol: control.symbol, barrier: String(barrier),
    });
    const quote = proposal.proposal;
    if (!quote?.id || !Number.isFinite(Number(quote.ask_price)) || !Number.isFinite(Number(quote.payout))) {
      throw new Error("Deriv proposal response is incomplete.");
    }
    await fencedEvent(epoch, "PROPOSAL_RECEIVED", orderUid, {
      proposalId: quote.id, askPrice: quote.ask_price, payout: quote.payout,
      grossPayout: quote.payout, stake, barrier, symbol: control.symbol,
    });
    if (!(await reserveOrder(sql, orderUid, epoch, INSTANCE_ID))) throw new Error("STOP_OR_FENCE_BLOCKED_BUY");
    const cap = await sql`UPDATE public.ddpe_bot_control
      SET plumbing_remaining = plumbing_remaining - 1, updated_at = NOW()
      WHERE owner_id = ${OWNER_ID} AND worker_epoch = ${epoch}
        AND worker_instance_id = ${INSTANCE_ID} AND worker_lease_expires_at > NOW()
        AND in_flight_order_uid = ${orderUid} AND stop_requested = false
        AND buy_unknown = false AND mode = 'PLUMBING_TEST' AND plumbing_remaining > 0
      RETURNING plumbing_remaining`;
    if (cap.length !== 1) throw new Error("PLUMBING_TRADE_CAP_REACHED_OR_STOPPED");
    await fencedEvent(epoch, "BUY_AUTHORIZED", orderUid, { stake, barrier });
    await fencedEvent(epoch, "BUY_SENT", orderUid, { proposalId: quote.id, stake, symbol: control.symbol, barrier });
    buySent = true;
    let bought;
    try {
      // Unary proposal IDs are informational. The Deriv schema permits a
      // parameterized buy (buy="1") with the proposal ask as the max price.
      bought = await socket.request({
        buy: "1", price: Number(quote.ask_price),
        parameters: {
          amount: stake, basis: "stake", contract_type: "DIGITDIFF",
          currency: account.currency, duration: 1, duration_unit: "t",
          underlying_symbol: control.symbol, barrier: String(barrier),
        },
      });
    } catch (error) {
      if (error?.code === "DERIV_REJECTED") {
        buySent = false;
        await fencedEvent(epoch, "WORKER_ERROR", orderUid, { kind: "BUY_REJECTED", error: error.message.slice(0, 250) });
      } else {
        await markBuyUnknown(orderUid, epoch, error.message);
      }
      throw error;
    }
    const contractId = Number(bought.buy?.contract_id);
    if (!Number.isSafeInteger(contractId) || contractId <= 0) {
      await markBuyUnknown(orderUid, epoch, "Buy response did not include a valid contract_id.");
      throw new Error("BUY_UNKNOWN_REQUIRES_RECONCILIATION");
    }
    await fencedEvent(epoch, "BUY_CONFIRMED", orderUid, {
      buyPrice: bought.buy.buy_price, transactionId: bought.buy.transaction_id,
    }, contractId);
    await monitorContract(socket, epoch, orderUid, contractId);
  } catch (error) {
    if (!buySent) {
      try { await fencedEvent(epoch, "ORDER_RELEASED", orderUid, { reason: "pre_buy_failure", error: String(error.message || "").slice(0, 200) }); } catch {}
      await releaseOrder(orderUid, epoch);
    }
    throw error;
  }
}
async function runWorker() {
  if (process.env.BOT_ENVIRONMENT !== "staging" || process.env.BOT_MODE !== "plumbing_test") {
    throw new Error("Worker refuses to run outside staging plumbing_test mode.");
  }
  let socket = null;
  let activeEpoch = null;
  while (true) {
    try {
      const control = await loadControl();
      if (!control) throw new Error("Worker migration is not installed.");
      const epoch = Number(control.worker_epoch);
      const shouldWork =
        (control.desired_running && !control.stop_requested) ||
        (Boolean(control.in_flight_order_uid) && !control.buy_unknown) ||
        (control.buy_unknown && control.reconciliation_requested);
      if (!shouldWork) {
        if (activeEpoch !== null) {
          await releaseWorkerLease(sql, activeEpoch, INSTANCE_ID);
          socket?.close(); socket = null; activeEpoch = null; lastLeaseRenewAt = 0;
        }
        await sleep(POLL_MS);
        continue;
      }
      const leaseAcquired = await ensureLease(epoch, activeEpoch !== epoch);
      if (!leaseAcquired) {
        socket?.close(); socket = null; activeEpoch = null; lastLeaseRenewAt = 0;
        await sleep(POLL_MS);
        continue;
      }
      if (activeEpoch !== epoch || !socket) {
        socket?.close();
        socket = (await openDemoSocket(epoch, control.demo_account_id)).socket;
        activeEpoch = epoch;
        lastHeartbeatAt = 0;
      }
      if (control.buy_unknown) {
        try {
          await findConfirmedContract(socket, epoch, control.buy_unknown_order_uid);
        } catch (error) {
          await sql`UPDATE public.ddpe_bot_control
            SET reconciliation_requested = false, updated_at = NOW()
            WHERE owner_id = ${OWNER_ID} AND worker_epoch = ${epoch}
              AND worker_instance_id = ${INSTANCE_ID} AND worker_lease_expires_at > NOW()
              AND buy_unknown = true AND buy_unknown_order_uid = ${control.buy_unknown_order_uid}`;
          throw error;
        }
        continue;
      }
      if (control.in_flight_order_uid) {
        await recoverOpenOrder(socket, epoch, control.in_flight_order_uid);
        continue;
      }
      await heartbeat(epoch);
      const { token } = await getCredentials();
      const accountBody = await restJson("https://api.derivws.com/trading/v1/options/accounts", token);
      const accounts = Array.isArray(accountBody?.data) ? accountBody.data : (accountBody?.data?.accounts || []);
      const account = accounts.find((item) => String(item.account_id || item.id || "") === control.demo_account_id);
      if (!account || !(account.account_type === "demo" || account.account_type === "virtual" || account.is_virtual === true)) {
        throw new Error("Selected Deriv account is not verified demo.");
      }
      await runOneCycle(socket, epoch, control, account);
      await sleep(POLL_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Worker error";
      if (activeEpoch !== null) {
        try {
          await sql`UPDATE public.ddpe_bot_control
            SET last_error = ${message.slice(0, 500)}, desired_running = false,
                stop_requested = true, updated_at = NOW()
            WHERE owner_id = ${OWNER_ID} AND worker_epoch = ${activeEpoch}
              AND worker_instance_id = ${INSTANCE_ID} AND worker_lease_expires_at > NOW()`;
          await fencedEvent(activeEpoch, "WORKER_ERROR", null, { error: message.slice(0, 300) });
        } catch {}
      }
      socket?.close(); socket = null; activeEpoch = null; lastLeaseRenewAt = 0;
      await sleep(POLL_MS);
    }
  }
}
runWorker().catch((error) => {
  process.stderr.write(`Lotus worker stopped: ${error.message}\n`);
  process.exitCode = 1;
});
