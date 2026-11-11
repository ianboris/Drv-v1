import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { calculateContractEconomics } from './riskCalculator';
import { runWalkForwardBacktest, type WalkForwardBacktestResult } from './backtest';
import { digitFromQuote, normalizePipSize } from './market-data.mjs';

// Public, read-only market-data endpoint for the current Deriv API.
// No App ID or account token is required for public symbols, ticks, history, or proposals.
const DERIV_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
type Tick = { id: string; symbol: string; quote: number; epoch: number; source: 'history' | 'live'; pipSize?: number; lastDigit?: number };
type ActiveSymbol = { underlying_symbol: string; underlying_symbol_name?: string; pip_size?: number; market?: string };
type Settings = { stake: number; dailyLossLimit: number; takeProfitLimit: number; windowSize: number };
type ProposalQuote = { barrier: number; askPrice: number; payout: number; quotedAt: number };
type ChoiceAggregate = { symbol: string; barrier: number; total: number; wins: number };
type ChoiceOutcome = { id: string; symbol: string; barrier: number; predictedEpoch: number; settledEpoch: number; outcomeDigit: number; correct: boolean; analysisWindow?: number };
type ResearchStrategy = 'DIFFERS' | 'MATCHES' | 'EVEN' | 'ODD';
type ResearchDecision = { id: string; symbol: string; strategy: ResearchStrategy; targetDigit: number; predictedEpoch: number; settledEpoch: number | null; outcomeDigit: number | null; correct: boolean | null; analysisWindow: number; sampleSize: number; empiricalRate: number; modelVersion: string };
type PendingResearch = { decision_uid: string; symbol: string; strategy: ResearchStrategy; target_digit: number; predicted_at_epoch: number; analysis_window: number; sample_size: number; empirical_rate: number; model_version: string };
type DemoDigitTrade = { contractId: string; accountId: string; symbol: string; strategy: 'DIFFERS' | 'MATCHES'; targetDigit: number; stake: number; status: string; pnl: number; openedAt: number; closedAt?: number };
type DemoOrderRequest = { kind: 'proposal' | 'buy'; symbol: string; strategy: 'DIFFERS' | 'MATCHES'; targetDigit: number; proposalId?: string; askPrice?: number };
const DEMO_TRADES_KEY = 'lotus-demo-digit-trades-v1';
const DEMO_DAILY_KEY = 'lotus-demo-digit-daily-v1';
function readDemoTrades(): DemoDigitTrade[] { try { const value = JSON.parse(localStorage.getItem(DEMO_TRADES_KEY) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } }
function readDemoDailyPnl(accountId: string): number { if (!accountId) return 0; try { const value = JSON.parse(localStorage.getItem(`${DEMO_DAILY_KEY}:${accountId}`) || '{}'); return value.day === new Date().toISOString().slice(0, 10) && Number.isFinite(value.pnl) ? value.pnl : 0; } catch { return 0; } }
type Tab = 'overview' | 'engine' | 'wins' | 'activity' | 'settings';
const DEFAULT_SETTINGS: Settings = { stake: 1, dailyLossLimit: 2, takeProfitLimit: 5, windowSize: 100 };

function readSettings(): Settings {
  try {
    const saved = localStorage.getItem('ddpe-settings-v1');
    if (!saved) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(saved) as Partial<Settings>;
    return {
      stake: Number.isFinite(parsed.stake) && Number(parsed.stake) > 0 ? Number(parsed.stake) : 1,
      dailyLossLimit: Number.isFinite(parsed.dailyLossLimit) && Number(parsed.dailyLossLimit) > 0 ? Number(parsed.dailyLossLimit) : 2,
      takeProfitLimit: Number.isFinite(parsed.takeProfitLimit) && Number(parsed.takeProfitLimit) > 0 ? Number(parsed.takeProfitLimit) : 5,
      windowSize: Number.isFinite(parsed.windowSize) && Number(parsed.windowSize) >= 50 ? Math.min(5000, Math.round(Number(parsed.windowSize))) : 100
    };
  } catch { return DEFAULT_SETTINGS; }
}

function getStats(digits: number[]) {
  const counts = Array<number>(10).fill(0);
  for (let i = 0; i < digits.length; i += 1) {
    const digit = digits[i];
    if (Number.isInteger(digit) && digit >= 0 && digit <= 9) counts[digit] += 1;
  }
  const n = digits.length;
  const probabilities = counts.map((count) => n ? count / n : 0);
  const entropy = -probabilities.reduce((sum, p) => sum + (p > 0 ? p * Math.log2(p) : 0), 0);
  const barrier = n ? probabilities.indexOf(Math.min(...probabilities)) : -1;
  return { counts, probabilities, entropy, barrier, barrierRate: barrier >= 0 ? probabilities[barrier] : 0, sample: n };
}

const RESEARCH_QUEUE_KEY = 'lotus-research-sync-v1';
function readResearchQueue(): Record<string, unknown>[] {
  try { const value = JSON.parse(localStorage.getItem(RESEARCH_QUEUE_KEY) || '[]'); return Array.isArray(value) ? value : []; }
  catch { return []; }
}
async function queueResearchDecision(decision: Record<string, unknown>) {
  const id = String(decision.decision_uid || '');
  const queue = readResearchQueue().filter(item => item.decision_uid !== id);
  queue.push(decision);
  try { localStorage.setItem(RESEARCH_QUEUE_KEY, JSON.stringify(queue.slice(-2000))); } catch {}
  // The periodic authenticated sync batches decisions to reduce request volume.
}
async function flushResearchQueue() {
  if (!navigator.onLine) return;
  const queue = readResearchQueue();
  if (!queue.length) return;
  for (let offset = 0; offset < queue.length; offset += 100) {
    const batch = queue.slice(offset, offset + 100);
    const response = await fetch('/api/research', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decisions: batch }) });
    if (!response.ok) throw new Error('Research sync is waiting for a connection.');
    const sent = new Set(batch.map(item => String(item.decision_uid)));
    const remaining = readResearchQueue().filter(item => !sent.has(String(item.decision_uid)));
    try { localStorage.setItem(RESEARCH_QUEUE_KEY, JSON.stringify(remaining)); } catch {}
  }
}

function formatUtc(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString('en-GB', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function wilsonLowerBound(wins: number, total: number, z = 1.96): number {
  if (!total) return 0;
  const p = wins / total;
  const z2 = z * z;
  return (p + z2 / (2 * total) - z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / (1 + z2 / total);
}

// Validate once per historical dataset/strategy/window. The cache prevents a full backtest
// from running again on every live tick while still invalidating when the market history changes.
const walkForwardEvidenceCache = new Map<string, { sampleId: string; result: WalkForwardBacktestResult }>();
function getWalkForwardEvidence(marketSymbol: string, ticks: Tick[], strategy: 'DIFFERS' | 'MATCHES', windowSize: number): WalkForwardBacktestResult | null {
  const historyTicks = ticks.filter(tick => tick.source === 'history').slice(-5000);
  const sampleId = historyTicks.length ? historyTicks[historyTicks.length - 1].id : '';
  const cacheKey = `${marketSymbol}:${strategy}:${windowSize}`;
  const cached = walkForwardEvidenceCache.get(cacheKey);
  if (cached?.sampleId === sampleId) return cached.result;
  // Preserve usable historical observations when lastDigit has not yet been attached.
  const digits = historyTicks
    .map(tick => Number.isInteger(tick.lastDigit) ? Number(tick.lastDigit) : tick.pipSize !== undefined ? digitFromQuote(tick.quote, tick.pipSize) : null)
    .filter((digit): digit is number => typeof digit === 'number' && Number.isInteger(digit) && digit >= 0 && digit <= 9);
  if (digits.length < windowSize + 100) return null;
  const result = runWalkForwardBacktest(digits, strategy, windowSize);
  if (walkForwardEvidenceCache.size > 100) walkForwardEvidenceCache.clear();
  walkForwardEvidenceCache.set(cacheKey, { sampleId, result });
  return result;
}

function App() {
  useEffect(() => { if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => undefined); }, []);
  const [tab, setTab] = useState<Tab>('overview');
  const [activeStrategy, setActiveStrategy] = useState<ResearchStrategy>('DIFFERS');
  const [analysisRunning, setAnalysisRunning] = useState(false);
  const [liveMaster, setLiveMaster] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => localStorage.getItem('lotus-theme') === 'light' ? 'light' : 'dark');
  const [symbol, setSymbol] = useState('1HZ100V');
  const [symbols, setSymbols] = useState<ActiveSymbol[]>([]);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [pipSize, setPipSize] = useState<number>();
  const [status, setStatus] = useState('CONNECTING');
  const [error, setError] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [derivDemoConnected, setDerivDemoConnected] = useState(false);
  const [derivDemoAccounts, setDerivDemoAccounts] = useState<Array<{account_id:string;currency:string;balance:number|null}>>([]);
  const [selectedDemoAccountId, setSelectedDemoAccountId] = useState('');
  const [derivDemoMessage, setDerivDemoMessage] = useState('Not connected');
  const [derivDemoBusy, setDerivDemoBusy] = useState(false);
  const [demoSocketStatus, setDemoSocketStatus] = useState<'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR'>('DISCONNECTED');
  const [demoAutoTrading, setDemoAutoTrading] = useState(false);
  const [demoTradeMessage, setDemoTradeMessage] = useState('Demo execution is stopped.');
  const [demoTrades, setDemoTrades] = useState<DemoDigitTrade[]>(readDemoTrades);
  const [demoDailyPnl, setDemoDailyPnl] = useState(0);
  const [backtestResult, setBacktestResult] = useState<WalkForwardBacktestResult | null>(null);
  const [backtestStrategy, setBacktestStrategy] = useState<ResearchStrategy>('DIFFERS');
  const [authChecking, setAuthChecking] = useState(true);
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [backendStatus, setBackendStatus] = useState('Checking backend');
  const [settings, setSettings] = useState<Settings>(readSettings);
  const [saved, setSaved] = useState(true);
  const [proposalQuotes, setProposalQuotes] = useState<Record<string, ProposalQuote>>({});
  const [choiceAggregates, setChoiceAggregates] = useState<ChoiceAggregate[]>([]);
  const [researchDecisions, setResearchDecisions] = useState<ResearchDecision[]>([]);
  const selectedDemoAccount = derivDemoAccounts.find(account => account.account_id === selectedDemoAccountId);
  const demoCurrency = selectedDemoAccount?.currency || '';
  const demoCurrencyRef = useRef(demoCurrency);
  demoCurrencyRef.current = demoCurrency;
  const [choiceOutcomes, setChoiceOutcomes] = useState<ChoiceOutcome[]>(() => {
    try { return JSON.parse(localStorage.getItem('ddpe-choice-outcomes-v1') || '[]') as ChoiceOutcome[]; }
    catch { return []; }
  });
  const ticksRef = useRef<Tick[]>([]);
  const uiTickPublishTimerRef = useRef<number | undefined>();
  useEffect(() => { analysisStateRef.current = { running: analysisRunning, strategy: activeStrategy }; }, [analysisRunning, activeStrategy]);
  useEffect(() => { try { localStorage.setItem('lotus-theme', theme); } catch {} document.body.dataset.theme = theme; }, [theme]);
  const pendingChoicesRef = useRef<Map<string, { id: string; symbol: string; barrier: number; predictedEpoch: number; analysisWindow: number }>>(new Map());
  const pendingResearchRef = useRef<Map<string, PendingResearch>>(new Map());
  const analysisStateRef = useRef<{ running: boolean; strategy: ResearchStrategy }>({ running: false, strategy: 'DIFFERS' });
  const ticksBySymbolRef = useRef<Map<string, Tick[]>>(new Map());
  const tickIdsBySymbolRef = useRef<Map<string, Set<string>>>(new Map());
  const pipSizesBySymbolRef = useRef<Map<string, number>>(new Map());
  const selectedSymbolRef = useRef(symbol);
  selectedSymbolRef.current = symbol;
  const windowSizeRef = useRef(settings.windowSize);
  windowSizeRef.current = settings.windowSize;
  const ws = useRef<WebSocket | null>(null);
  const demoWs = useRef<WebSocket | null>(null);
  const demoOrderRequestsRef = useRef<Map<number, DemoOrderRequest>>(new Map());
  const demoOrderTimeoutsRef = useRef<Map<number, number>>(new Map());
  const demoTradeMapRef = useRef<Map<string, DemoDigitTrade>>(new Map());
  const openDemoContractRef = useRef<string | null>(null);
  const demoAutoTradingRef = useRef(false);
  const demoDailyPnlRef = useRef(demoDailyPnl);
  const demoRequestIdRef = useRef(7000);
  const demoLastOrderAtRef = useRef(0);
  const demoReconnectAttemptRef = useRef(0);
  const demoReconnectTimerRef = useRef<number | undefined>();
  const demoSessionWantedRef = useRef(false);
  const demoConnectionGenerationRef = useRef(0);
  const demoHeartbeatIntervalRef = useRef<number | undefined>();
  const demoHeartbeatTimeoutRef = useRef<number | undefined>();
  const demoConnectTimeoutRef = useRef<number | undefined>();
  const demoHeartbeatReqIdRef = useRef(950000);
  const demoHeartbeatAwaitingRef = useRef(false);
  const reconnectTimer = useRef<number | undefined>();
  const pendingTicksRef = useRef<Array<{ tick_uid: string; symbol: string; epoch: number; quote: number; pip_size: number; last_digit: number }>>([]);
  const persistInFlightRef = useRef(false);
  const proposalRequestsRef = useRef(new Map<number, { symbol: string; barrier: number; currency: string; stake: number }>());
  const proposalReqIdRef = useRef(3000);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  useEffect(() => { demoAutoTradingRef.current = demoAutoTrading; }, [demoAutoTrading]);
  useEffect(() => { demoDailyPnlRef.current = demoDailyPnl; }, [demoDailyPnl]);
  useEffect(() => {
    const accountTrades = demoTrades.filter(trade => trade.accountId === selectedDemoAccountId && trade.status === 'OPEN');
    demoTradeMapRef.current = new Map(accountTrades.map(trade => [trade.contractId, trade]));
    openDemoContractRef.current = accountTrades[0]?.contractId || null;
    const pnl = readDemoDailyPnl(selectedDemoAccountId);
    demoDailyPnlRef.current = pnl;
    setDemoDailyPnl(pnl);
  }, [selectedDemoAccountId]);
  useEffect(() => { try { localStorage.setItem(DEMO_TRADES_KEY, JSON.stringify(demoTrades.slice(-200))); } catch {} }, [demoTrades]);

  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    fetch('/api/deriv/demo/status', { credentials: 'same-origin' })
      .then(response => response.ok ? response.json() : Promise.reject(new Error('No Deriv demo connection')))
      .then(async data => {
        if (!active) return;
        setDerivDemoConnected(Boolean(data.connected));
        setDerivDemoMessage(data.connected ? 'Deriv authorization connected · demo account not yet selected' : 'Not connected');
        if (data.connected) {
          const response = await fetch('/api/deriv/demo/accounts', { credentials: 'same-origin' });
          if (!response.ok) throw new Error('Could not load demo accounts. Reconnect Deriv.');
          const result = await response.json();
          if (!active) return;
          setDerivDemoAccounts(result.accounts || []);
          if (data.account_id) setSelectedDemoAccountId(data.account_id);
          else if (result.accounts?.[0]) setSelectedDemoAccountId(result.accounts[0].account_id);
        }
      })
      .catch(() => { if (active) { setDerivDemoConnected(false); setDerivDemoMessage('Not connected'); } });
    return () => { active = false; };
  }, [authenticated]);

  useEffect(() => () => {
    for (const timer of demoOrderTimeoutsRef.current.values()) window.clearTimeout(timer);
    demoOrderTimeoutsRef.current.clear();
    demoSessionWantedRef.current = false;
    demoConnectionGenerationRef.current += 1;
    if (demoReconnectTimerRef.current) window.clearTimeout(demoReconnectTimerRef.current);
    if (demoHeartbeatIntervalRef.current) window.clearInterval(demoHeartbeatIntervalRef.current);
    if (demoHeartbeatTimeoutRef.current) window.clearTimeout(demoHeartbeatTimeoutRef.current);
    if (demoConnectTimeoutRef.current) window.clearTimeout(demoConnectTimeoutRef.current);
    const socket = demoWs.current;
    if (socket) { socket.onclose = null; socket.close(); }
  }, []);

  useEffect(() => {
    if (!authenticated) { setStatus('LOCKED'); return; }
    ticksBySymbolRef.current.clear();
    pipSizesBySymbolRef.current.clear();
    pendingChoicesRef.current.clear();
    ticksRef.current = [];
    setTicks([]);
    setPipSize(undefined);
    let alive = true;
    let socket: WebSocket | null = null;
    const subscriptionTimers: number[] = [];
    let reconnectAttempt = 0;
    let stableConnectionTimer: number | undefined;
    let heartbeatInterval: number | undefined;
    let heartbeatTimeout: number | undefined;
    let tickWatchdogInterval: number | undefined;
    let lastMarketTickAt = 0;
    let heartbeatRequestId = 900000;
    let awaitingHeartbeat = false;
    const connect = () => {
      if (!alive) return;
      setStatus('CONNECTING');
      console.info('[DERIV] Opening public market-data WebSocket', { endpoint: DERIV_WS_URL });
      socket = new WebSocket(DERIV_WS_URL);
      ws.current = socket;
      socket.onopen = () => {
        if (!alive || !socket) return;
        if (stableConnectionTimer) window.clearTimeout(stableConnectionTimer);
        stableConnectionTimer = window.setTimeout(() => {
          reconnectAttempt = 0;
          console.info('[DERIV] Connection stable; reconnect backoff reset');
        }, 60000);
        console.info('[DERIV] WebSocket connected', { readyState: socket.readyState });
        setStatus('CONNECTED');
        setError('');
        lastMarketTickAt = Date.now();
        tickWatchdogInterval = window.setInterval(() => {
          if (!alive || socket?.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastMarketTickAt > 90000) {
            console.warn('[DERIV] No market ticks received for 90 seconds; restarting public feed');
            socket.close(4001, 'Market tick stream stale');
          }
        }, 15000);
        heartbeatInterval = window.setInterval(() => {
          if (!alive || socket?.readyState !== WebSocket.OPEN || awaitingHeartbeat) return;
          awaitingHeartbeat = true;
          const reqId = heartbeatRequestId++;
          socket.send(JSON.stringify({ ping: 1, req_id: reqId }));
          heartbeatTimeout = window.setTimeout(() => {
            if (!alive || !awaitingHeartbeat || socket?.readyState !== WebSocket.OPEN) return;
            console.warn('[DERIV] Heartbeat response timed out; restarting connection');
            socket.close(4000, 'Heartbeat timeout');
          }, 10000);
        }, 30000);
        // Ask Deriv for underlyings supporting either digit contract family.
        // The current API no longer accepts product_type on active_symbols.
        socket.send(JSON.stringify({ active_symbols: 'brief', req_id: 1 }));
      };
      socket.onmessage = (event) => {
        if (!alive) return;
        try {
          const response = JSON.parse(event.data);
          if (response.msg_type === 'tick' && response.tick) lastMarketTickAt = Date.now();
          if (response.msg_type === 'ping') {
            if (Number(response.req_id) === heartbeatRequestId - 1) {
              awaitingHeartbeat = false;
              if (heartbeatTimeout) window.clearTimeout(heartbeatTimeout);
              heartbeatTimeout = undefined;
              console.debug('[DERIV] Heartbeat acknowledged');
            }
            return;
          }
          if (response.error) {
            const failedReqId = Number(response.req_id);
            if (Number.isInteger(failedReqId)) proposalRequestsRef.current.delete(failedReqId);
            setError(response.error.message || 'Deriv API error');
            if (failedReqId === 1 && socket?.readyState === WebSocket.OPEN) socket.close(4002, 'active_symbols request rejected');
            return;
          }
          if (response.msg_type === 'proposal' && response.proposal) {
            const reqId = Number(response.req_id);
            const request = proposalRequestsRef.current.get(reqId);
            if (request && request.currency === demoCurrencyRef.current && request.stake === settingsRef.current.stake) {
              const askPrice = Number(response.proposal.ask_price);
              const payout = Number(response.proposal.payout);
              if (Number.isFinite(askPrice) && askPrice > 0 && Number.isFinite(payout) && payout > askPrice) {
                setProposalQuotes((previous) => ({ ...previous, [request.symbol]: { barrier: request.barrier, askPrice, payout, quotedAt: Date.now() } }));
              }
              proposalRequestsRef.current.delete(reqId);
            }
            return;
          }
          if (response.msg_type === 'active_symbols') {
            const list: ActiveSymbol[] = (response.active_symbols || []).filter((item: ActiveSymbol) => item.market === 'synthetic_index' && !/boom|crash/i.test(`${item.underlying_symbol} ${item.underlying_symbol_name || ''}`));
            setSymbols(list);
            // Cache symbol precision, but keep exactly one live tick subscription.
            // Subscribing to every returned market exhausted Deriv's subscription capacity.
            list.forEach((item) => {
              const marketSymbol = item.underlying_symbol;
              if (!marketSymbol) return;
              const symbolPrecision = normalizePipSize(item.pip_size);
              if (symbolPrecision !== undefined) pipSizesBySymbolRef.current.set(marketSymbol, symbolPrecision);
            });
            const selected = selectedSymbolRef.current;
            if (list.length && !list.some((item) => item.underlying_symbol === selected)) {
              const first = list[0].underlying_symbol;
              if (first) selectSymbol(first);
            } else {
              setPipSize(pipSizesBySymbolRef.current.get(selected));
              subscribeMarket(selected);
            }
          }
          if (response.msg_type === 'history') {
            const historySymbol = response.echo_req?.ticks_history || response.passthrough?.symbol;
            if (typeof historySymbol !== 'string') return;
            const prices: number[] = response.history?.prices || [];
            const times: number[] = response.history?.times || [];
            const history = prices.map((quote, i) => ({
              id: `history:${historySymbol}:${times[i]}:${quote}:${i}`,
              symbol: historySymbol,
              quote: Number(quote),
              epoch: Number(times[i]),
              source: 'history' as const,
            })).filter((tick) => Number.isFinite(tick.quote) && Number.isSafeInteger(tick.epoch));
            const responsePrecision = normalizePipSize(response.pip_size, prices.at(-1));
            if (responsePrecision !== undefined) pipSizesBySymbolRef.current.set(historySymbol, responsePrecision);
            const precision = pipSizesBySymbolRef.current.get(historySymbol);
            const merged = new Map<string, Tick>();
            [...history, ...(ticksBySymbolRef.current.get(historySymbol) || [])].forEach((tick) => merged.set(tick.id, tick));
            let nextTicks = [...merged.values()].sort((a, b) => a.epoch - b.epoch).slice(-5000);
            if (precision !== undefined) {
              nextTicks = nextTicks.map((tick) => tick.pipSize === undefined
                ? { ...tick, pipSize: precision, lastDigit: digitFromQuote(tick.quote, precision) }
                : tick);
              nextTicks.filter((tick) => tick.source === 'live' && tick.pipSize !== undefined).forEach((tick) => {
                if (!pendingTicksRef.current.some((queued) => queued.tick_uid === tick.id)) {
                  pendingTicksRef.current.push({
                    tick_uid: tick.id, symbol: tick.symbol, epoch: tick.epoch, quote: tick.quote,
                    pip_size: tick.pipSize!, last_digit: tick.lastDigit!,
                  });
                }
              });
            }
            ticksBySymbolRef.current.set(historySymbol, nextTicks);
            tickIdsBySymbolRef.current.set(historySymbol, new Set(nextTicks.map(tick => tick.id)));
            requestMarketProposal(historySymbol, nextTicks);
            if (historySymbol === selectedSymbolRef.current) {
              ticksRef.current = nextTicks;
              setTicks(nextTicks);
              setPipSize(precision);
            }
          }
          if (response.msg_type === 'tick' && response.tick) {
            const marketSymbol = String(response.tick.symbol || response.echo_req?.ticks || '');
            if (!marketSymbol) return;
            const quote = Number(response.tick.quote);
            const epoch = Number(response.tick.epoch);
            const responsePrecision = normalizePipSize(response.tick.pip_size, quote);
            if (responsePrecision !== undefined) {
              pipSizesBySymbolRef.current.set(marketSymbol, responsePrecision);
              if (marketSymbol === selectedSymbolRef.current) setPipSize(responsePrecision);
            }
            const tickPipSize = pipSizesBySymbolRef.current.get(marketSymbol);
            if (Number.isFinite(quote) && Number.isSafeInteger(epoch)) {
              const derivTickId = response.tick.id !== undefined && response.tick.id !== null
                ? String(response.tick.id)
                : crypto.randomUUID();
              const tick: Tick = {
                id: `live:${marketSymbol}:${derivTickId}`,
                symbol: marketSymbol,
                quote,
                epoch,
                source: 'live',
                ...(tickPipSize !== undefined
                  ? { pipSize: tickPipSize, lastDigit: digitFromQuote(quote, tickPipSize) }
                  : {}),
              };
              const currentTicks = ticksBySymbolRef.current.get(marketSymbol) || [];
              const seenTickIds = tickIdsBySymbolRef.current.get(marketSymbol) || new Set<string>();
              if (!seenTickIds.has(tick.id)) {
                seenTickIds.add(tick.id);
                tickIdsBySymbolRef.current.set(marketSymbol, seenTickIds);
                if (tick.pipSize !== undefined && tick.lastDigit !== undefined) {
                  pendingTicksRef.current.push({
                    tick_uid: tick.id, symbol: marketSymbol, epoch, quote,
                    pip_size: tick.pipSize, last_digit: tick.lastDigit,
                  });
                  for (const [researchKey, pendingResearch] of pendingResearchRef.current) {
                    if (pendingResearch.symbol !== marketSymbol) continue;
                    const isCorrect = pendingResearch.strategy === 'DIFFERS' ? tick.lastDigit !== pendingResearch.target_digit : pendingResearch.strategy === 'MATCHES' ? tick.lastDigit === pendingResearch.target_digit : pendingResearch.strategy === 'EVEN' ? tick.lastDigit % 2 === 0 : tick.lastDigit % 2 === 1;
                    const settled: ResearchDecision = { id: pendingResearch.decision_uid, symbol: marketSymbol, strategy: pendingResearch.strategy, targetDigit: pendingResearch.target_digit, predictedEpoch: pendingResearch.predicted_at_epoch, settledEpoch: epoch, outcomeDigit: tick.lastDigit, correct: isCorrect, analysisWindow: pendingResearch.analysis_window, sampleSize: pendingResearch.sample_size, empiricalRate: pendingResearch.empirical_rate, modelVersion: pendingResearch.model_version };
                    setResearchDecisions(previous => [...previous.filter(item => item.id !== settled.id), settled].slice(-2000));
                    queueResearchDecision({ ...pendingResearch, settled_at_epoch: epoch, outcome_digit: tick.lastDigit, is_correct: isCorrect }).then(() => setBackendStatus('Research settlement queued for sync')).catch(() => setBackendStatus('Research journal queued for sync'));
                    pendingResearchRef.current.delete(researchKey);
                  }
                  const pending = pendingChoicesRef.current.get(marketSymbol);
                  if (pending) {
                    const outcome: ChoiceOutcome = {
                      id: pending.id,
                      symbol: pending.symbol,
                      barrier: pending.barrier,
                      predictedEpoch: pending.predictedEpoch,
                      settledEpoch: epoch,
                      outcomeDigit: tick.lastDigit,
                      correct: tick.lastDigit !== pending.barrier,
                      analysisWindow: pending.analysisWindow,
                    };
                    setChoiceOutcomes((previous) => {
                      const updated = [...previous.filter((item) => item.id !== outcome.id), outcome].slice(-5000);
                      try { localStorage.setItem('ddpe-choice-outcomes-v1', JSON.stringify(updated)); } catch {}
                      return updated;
                    });
                    setChoiceAggregates((previous) => {
                      const existing = previous.find((item) => item.symbol === outcome.symbol && item.barrier === outcome.barrier);
                      if (existing) return previous.map((item) => item === existing ? { ...item, total: item.total + 1, wins: item.wins + (outcome.correct ? 1 : 0) } : item);
                      return [...previous, { symbol: outcome.symbol, barrier: outcome.barrier, total: 1, wins: outcome.correct ? 1 : 0 }];
                    });
                    fetch('/api/choices', {
                      method: 'POST',
                      credentials: 'same-origin',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ choices: [{
                        choice_uid: outcome.id,
                        symbol: outcome.symbol,
                        barrier_digit: outcome.barrier,
                        predicted_at_epoch: outcome.predictedEpoch,
                        settled_at_epoch: outcome.settledEpoch,
                        outcome_digit: outcome.outcomeDigit,
                        is_correct: outcome.correct,
                        analysis_window: outcome.analysisWindow ?? windowSizeRef.current,
                      }] }),
                    }).then((response) => {
                      if (!response.ok) throw new Error('Paper choice persistence failed.');
                    }).catch(() => setBackendStatus('Prediction persistence failed'));
                    pendingChoicesRef.current.delete(marketSymbol);
                  }
                  const priorDigits = currentTicks.slice(-windowSizeRef.current).map((item) =>
                    item.lastDigit ?? digitFromQuote(item.quote, tickPipSize));
                  const priorStats = priorDigits.length >= windowSizeRef.current ? getStats(priorDigits) : null;
                  if (priorStats && demoAutoTradingRef.current && marketSymbol === selectedSymbolRef.current) {
                    const demoStrategy = analysisStateRef.current.strategy;
                    const demoTarget = demoStrategy === 'DIFFERS' ? priorStats.barrier : demoStrategy === 'MATCHES' ? priorStats.counts.indexOf(Math.max(...priorStats.counts)) : -1;
                    if (demoTarget >= 0) requestDemoDigitTrade(marketSymbol, demoStrategy, demoTarget);
                  }
                  if (priorStats && analysisStateRef.current.running) {
                    const strategy = analysisStateRef.current.strategy;
                    const targetDigit = strategy === 'DIFFERS' ? priorStats.barrier : strategy === 'MATCHES' ? priorStats.counts.indexOf(Math.max(...priorStats.counts)) : strategy === 'EVEN' ? 0 : 1;
                    if (targetDigit >= 0) {
                      const empiricalRate = strategy === 'DIFFERS' ? 1 - priorStats.probabilities[targetDigit] : strategy === 'MATCHES' ? priorStats.probabilities[targetDigit] : priorDigits.filter(digit => strategy === 'EVEN' ? digit % 2 === 0 : digit % 2 === 1).length / priorDigits.length;
                      const pendingResearch: PendingResearch = { decision_uid: crypto.randomUUID(), symbol: marketSymbol, strategy, target_digit: targetDigit, predicted_at_epoch: epoch, analysis_window: windowSizeRef.current, sample_size: priorStats.sample, empirical_rate: Number(empiricalRate.toFixed(6)), model_version: 'frequency-baseline-v1' };
                      pendingResearchRef.current.set(marketSymbol + ':' + strategy, pendingResearch);
                      const openDecision: ResearchDecision = { id: pendingResearch.decision_uid, symbol: marketSymbol, strategy, targetDigit, predictedEpoch: epoch, settledEpoch: null, outcomeDigit: null, correct: null, analysisWindow: pendingResearch.analysis_window, sampleSize: pendingResearch.sample_size, empiricalRate: pendingResearch.empirical_rate, modelVersion: pendingResearch.model_version };
                      setResearchDecisions(previous => [...previous.filter(item => item.id !== openDecision.id), openDecision].slice(-2000));
                      queueResearchDecision({ ...pendingResearch, settled_at_epoch: null, outcome_digit: null, is_correct: null }).then(() => setBackendStatus('Research decision queued for sync')).catch(() => setBackendStatus('Research decision queue unavailable'));
                    }
                  }
                  if (priorStats && priorStats.barrier >= 0) {
                      pendingChoicesRef.current.set(marketSymbol, {
                        id: crypto.randomUUID(),
                        symbol: marketSymbol,
                        barrier: priorStats.barrier,
                        predictedEpoch: epoch,
                        analysisWindow: windowSizeRef.current,
                      });
                    }
                }
                const lastTick = currentTicks[currentTicks.length - 1];
                const appendedTicks = !lastTick || tick.epoch >= lastTick.epoch
                  ? [...currentTicks, tick]
                  : [...currentTicks, tick].sort((a, b) => a.epoch - b.epoch);
                const nextTicks = appendedTicks.slice(-5000);
                if (seenTickIds.size > 6000) tickIdsBySymbolRef.current.set(marketSymbol, new Set(nextTicks.map(item => item.id)));
                ticksBySymbolRef.current.set(marketSymbol, nextTicks);
                if (marketSymbol === selectedSymbolRef.current) {
                  ticksRef.current = nextTicks;
                  // Keep the feed hot in refs, but batch React renders to avoid a full dashboard render per tick.
                  if (uiTickPublishTimerRef.current === undefined) {
                    uiTickPublishTimerRef.current = window.setTimeout(() => {
                      uiTickPublishTimerRef.current = undefined;
                      setTicks(ticksRef.current);
                    }, 75);
                  }
                }
              }
            }
          }
        } catch { setError('Could not read the Deriv market-data response.'); }
      };
      socket.onerror = (event) => {
        console.error('[DERIV] WebSocket error event', event);
        if (alive) setError('Deriv WebSocket connection error. Check the browser console and Network → WS for handshake details.');
      };
      socket.onclose = (event) => {
        console.error('[DERIV] WebSocket closed', {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
          readyState: socket?.readyState,
        });
        if (stableConnectionTimer) window.clearTimeout(stableConnectionTimer);
        if (heartbeatInterval) window.clearInterval(heartbeatInterval);
        if (heartbeatTimeout) window.clearTimeout(heartbeatTimeout);
        if (tickWatchdogInterval) window.clearInterval(tickWatchdogInterval);
        awaitingHeartbeat = false;
        if (!alive) return;
        subscriptionTimers.forEach((timer) => window.clearTimeout(timer));
        subscriptionTimers.length = 0;
        setStatus('RECONNECTING');
        const delay = Math.min(30000, 1500 * (2 ** Math.min(reconnectAttempt, 5)));
        reconnectAttempt += 1;
        setError(`Deriv WebSocket closed (code ${event.code}${event.reason ? `: ${event.reason}` : ''}). Retrying in ${Math.round(delay / 1000)}s.`);
        reconnectTimer.current = window.setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      alive = false;
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
      if (stableConnectionTimer) window.clearTimeout(stableConnectionTimer);
      if (heartbeatInterval) window.clearInterval(heartbeatInterval);
      if (heartbeatTimeout) window.clearTimeout(heartbeatTimeout);
      if (tickWatchdogInterval) window.clearInterval(tickWatchdogInterval);
      subscriptionTimers.forEach((timer) => window.clearTimeout(timer));
      if (socket) {
        if (socket.readyState === WebSocket.OPEN) {
          try { socket.send(JSON.stringify({ forget_all: 'ticks' })); } catch {}
        }
        socket.close();
      }
      if (ws.current === socket) ws.current = null;
    };
  }, [authenticated]);

  useEffect(() => {
    let active = true;
    fetch('/api/health', { cache: 'no-store' }).then(async (response) => {
      const data = await response.json();
      if (!active) return;
      const checks = data?.checks;
      if (response.ok && checks?.database_connected && checks?.schema_ready && checks?.login_configured && checks?.session_secret_configured) {
        setBackendStatus('Backend ready · Neon connected');
      } else if (!checks?.database_connected) {
        setBackendStatus('Neon database not connected');
      } else if (!checks?.schema_ready) {
        setBackendStatus('Neon migrations not applied');
      } else {
        setBackendStatus('Backend configuration incomplete');
      }
    }).catch(() => { if (active) setBackendStatus('Backend unavailable'); });
    fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' }).then(async (response) => {
      if (!response.ok) return null;
      return response.json();
    }).then(async (session) => {
      if (!active || !session?.authenticated) return;
      const response = await fetch('/api/settings', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load saved settings from the backend.');
      const remote = await response.json();
      if (!active) return;
      setSettings({ stake: Number(remote.stake), dailyLossLimit: Number(remote.dailyLossLimit), takeProfitLimit: Number(remote.takeProfitLimit), windowSize: Number(remote.windowSize) });
      setAuthenticated(true);
      setSettingsLoaded(true);
    }).catch((reason) => { if (active) setLoginError(reason instanceof Error ? reason.message : 'Backend session check failed.'); })
      .finally(() => { if (active) setAuthChecking(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    const timer = window.setInterval(async () => {
      if (persistInFlightRef.current || !pendingTicksRef.current.length) return;
      persistInFlightRef.current = true;
      const batch = pendingTicksRef.current.slice(0, 100);
      const ids = new Set(batch.map((tick) => tick.tick_uid));
      try {
        const response = await fetch('/api/ticks', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ticks: batch }),
        });
        if (!response.ok) throw new Error('Tick persistence rejected.');
        pendingTicksRef.current = pendingTicksRef.current.filter((tick) => !ids.has(tick.tick_uid));
        setBackendStatus('Database connected · ticks saving');
      } catch {
        setBackendStatus('Tick persistence failed · retrying');
      } finally {
        persistInFlightRef.current = false;
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) return;
    const flush = () => { flushResearchQueue().catch(() => setBackendStatus('Offline journal queue · awaiting sync')); };
    window.addEventListener('online', flush);
    const timer = window.setInterval(flush, 15000);
    flush();
    return () => { window.removeEventListener('online', flush); window.clearInterval(timer); };
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    fetch('/api/research', { credentials: 'same-origin', cache: 'no-store' }).then(async response => { if (!response.ok) throw new Error('Research journal unavailable'); return response.json(); }).then(data => { if (active && Array.isArray(data.decisions)) setResearchDecisions(data.decisions); }).catch(() => { if (active) setBackendStatus('Research journal unavailable'); });
    return () => { active = false; };
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    fetch('/api/choices', { credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load paper choices from Neon.');
        return response.json();
      })
      .then((data) => {
        if (!active || !Array.isArray(data.choices)) return;
        setChoiceOutcomes([...data.choices].sort((a, b) => a.settledEpoch - b.settledEpoch));
        setChoiceAggregates(Array.isArray(data.aggregates) ? data.aggregates : []);
        try { localStorage.setItem('ddpe-choice-outcomes-v1', JSON.stringify(data.choices)); } catch {}
      })
      .catch(() => { if (active) setBackendStatus('Prediction history unavailable'); });
    return () => { active = false; };
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated || !settingsLoaded) return;
    if (!(settings.stake > 0 && settings.stake <= 1000 && settings.dailyLossLimit > 0 && settings.dailyLossLimit <= 10000 && settings.takeProfitLimit > 0 && settings.takeProfitLimit <= 10000 && Number.isInteger(settings.windowSize) && settings.windowSize >= 50 && settings.windowSize <= 5000)) {
      setSaved(false);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      setSaved(false);
      fetch('/api/settings', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) })
        .then((response) => { if (!response.ok) throw new Error('Server rejected settings.'); return response.json(); })
        .then(() => { if (active) setSaved(true); })
        .catch(() => { if (active) { setSaved(false); setBackendStatus('Settings save failed'); } });
    }, 500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [settings, authenticated, settingsLoaded]);

  const digits = useMemo(() => ticks.map((tick) => tick.lastDigit ?? digitFromQuote(tick.quote, pipSize)), [ticks, pipSize]);
  const rollingDigits = digits.slice(-settings.windowSize);
  const stats = useMemo(() => getStats(rollingDigits), [rollingDigits]);
  const overallStats = useMemo(() => getStats(digits), [digits]);
  const marketName = symbols.find((item) => item.underlying_symbol === symbol)?.underlying_symbol_name || symbol;
  const scannerRows = useMemo(() => symbols.map((item) => {
    const history = choiceAggregates.filter((choice) => choice.symbol === item.underlying_symbol);
    const wins = history.reduce((sum, choice) => sum + choice.wins, 0);
    const total = history.reduce((sum, choice) => sum + choice.total, 0);
    const storedQuote = proposalQuotes[item.underlying_symbol];
    const quote = storedQuote && Date.now() - storedQuote.quotedAt <= 90000 ? storedQuote : undefined;
    const winRate = total ? wins / total : null;
    const matched = quote ? history.find((choice) => choice.barrier === quote.barrier) : undefined;
    const matchedSample = matched?.total ?? 0;
    const matchedWins = matched?.wins ?? 0;
    const matchedWinRate = matchedSample ? matchedWins / matchedSample : null;
    const conservativeWinRate = matchedSample ? wilsonLowerBound(matchedWins, matchedSample) : null;
    const conservativeEv = quote && matchedSample >= 100 && conservativeWinRate !== null ? calculateContractEconomics({ stake: quote.askPrice, payout: quote.payout, estimatedWinProbability: conservativeWinRate }).expectedValue : null;
    return { symbol: item.underlying_symbol, name: item.underlying_symbol_name || item.underlying_symbol, total, wins, winRate, matchedSample, matchedWinRate, conservativeWinRate, quote, conservativeEv };
  }).sort((a, b) => (b.conservativeEv ?? -Infinity) - (a.conservativeEv ?? -Infinity)), [symbols, choiceAggregates, proposalQuotes]);
  const qualifiedMarkets = scannerRows.filter((row) => row.matchedSample >= 100 && row.quote && row.conservativeEv !== null && row.conservativeEv > 0);
  const bestMarket = qualifiedMarkets[0] || null;
  const highestWinRateMarket = scannerRows.filter((row) => row.total >= 100 && row.winRate !== null).sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1))[0] || null;
  const symbolOutcomes = choiceOutcomes.filter((item) => item.symbol === symbol);
  // The journal is scoped to the currently selected market. Historical records from other symbols remain in storage for research, but are not mixed into this market's journal view.
  const marketResearchDecisions = researchDecisions.filter((item) => item.symbol === symbol);
  const accountDemoTrades = demoTrades.filter(trade => trade.accountId === selectedDemoAccountId);
  const settledDemoTrades = accountDemoTrades.filter(trade => trade.status !== 'OPEN');
  const demoRealizedPnl = settledDemoTrades.reduce((sum, trade) => sum + (Number.isFinite(trade.pnl) ? trade.pnl : 0), 0);
  const demoWinningTrades = settledDemoTrades.filter(trade => trade.pnl > 0).length;
  const demoWinRate = settledDemoTrades.length ? demoWinningTrades / settledDemoTrades.length * 100 : null;
  const overviewDemoMarketLeaders = Array.from(settledDemoTrades.reduce((map, trade) => {
    const current = map.get(trade.symbol) || { symbol: trade.symbol, pnl: 0, trades: 0, wins: 0 };
    current.pnl += trade.pnl;
    current.trades += 1;
    if (trade.pnl > 0) current.wins += 1;
    map.set(trade.symbol, current);
    return map;
  }, new Map<string, {symbol:string;pnl:number;trades:number;wins:number}>()).values())
    .map(row => ({...row, name: symbols.find(item => item.underlying_symbol === row.symbol)?.underlying_symbol_name || row.symbol}))
    .sort((a,b) => b.pnl-a.pnl);
  const overviewMarketLeaders = Array.from(researchDecisions.reduce((map, item) => {
    if (item.correct === null) return map;
    const current = map.get(item.symbol) || { symbol: item.symbol, wins: 0, losses: 0, total: 0 };
    current.total += 1;
    if (item.correct) current.wins += 1; else current.losses += 1;
    map.set(item.symbol, current);
    return map;
  }, new Map<string, {symbol:string;wins:number;losses:number;total:number}>()).values())
    .map(row => ({...row, rate: row.wins / row.total, name: symbols.find(item=>item.underlying_symbol===row.symbol)?.underlying_symbol_name || row.symbol}))
    .sort((a,b) => b.rate-a.rate || b.total-a.total);
  const settledCorrect = symbolOutcomes.filter((item) => item.correct).length;
  const settledAccuracy = symbolOutcomes.length ? settledCorrect / symbolOutcomes.length * 100 : null;
  const changeSetting = (key: keyof Settings, value: number) => {
    setSettings((current) => ({ ...current, [key]: value } as Settings));
    setSaved(false);
  };
  async function beginDerivOAuth() {
    setDerivDemoBusy(true);
    setDerivDemoMessage('Opening secure Deriv authorization…');
    try {
      const response = await fetch('/api/deriv/oauth/start', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
      const result = await response.json();
      if (!response.ok || !result.authorization_url) throw new Error(result.error || 'Could not start Deriv authorization.');
      window.location.assign(result.authorization_url);
    } catch (error) {
      setDerivDemoMessage(error instanceof Error ? error.message : 'Deriv authorization failed.');
      setDerivDemoBusy(false);
    }
  }

  function scheduleDemoReconnect(accountId: string, generation: number, reason: string) {
    if (!demoSessionWantedRef.current || generation !== demoConnectionGenerationRef.current) return;
    if (demoReconnectTimerRef.current) window.clearTimeout(demoReconnectTimerRef.current);
    const delay = Math.min(30000, 1500 * (2 ** Math.min(demoReconnectAttemptRef.current, 5)));
    demoReconnectAttemptRef.current += 1;
    setDemoSocketStatus('CONNECTING');
    setDerivDemoMessage(`Demo execution disconnected (${reason}). Reconnecting in ${Math.ceil(delay / 1000)}s…`);
    demoReconnectTimerRef.current = window.setTimeout(() => {
      demoReconnectTimerRef.current = undefined;
      void connectDemoExecutionSocket(accountId, generation);
    }, delay);
  }

  function clearDemoOrderTimeout(reqId: number) {
    const timer = demoOrderTimeoutsRef.current.get(reqId);
    if (timer !== undefined) window.clearTimeout(timer);
    demoOrderTimeoutsRef.current.delete(reqId);
  }

  function armDemoOrderTimeout(reqId: number, kind: 'proposal' | 'buy', timeoutMs: number) {
    clearDemoOrderTimeout(reqId);
    const timer = window.setTimeout(() => {
      demoOrderTimeoutsRef.current.delete(reqId);
      const pending = demoOrderRequestsRef.current.get(reqId);
      if (!pending || pending.kind !== kind) return;
      demoOrderRequestsRef.current.delete(reqId);
      if (kind === 'buy') {
        // A timed-out buy may have reached Deriv even if its acknowledgement did not reach us.
        // Pause rather than retry: the user must inspect Deriv's demo contract history first.
        demoAutoTradingRef.current = false;
        setDemoAutoTrading(false);
        setDemoTradeMessage('BUY ACKNOWLEDGEMENT TIMED OUT. Bot paused to prevent a duplicate purchase. Check the selected Deriv demo account contract history before restarting.');
      } else {
        setDemoTradeMessage('NO PROPOSAL RESPONSE FROM DERIV WITHIN 12 SECONDS. No buy was submitted. Check the demo socket and Deriv API error message, then reconnect if needed.');
      }
    }, timeoutMs);
    demoOrderTimeoutsRef.current.set(reqId, timer);
  }

  async function connectDemoExecutionSocket(accountId: string, generation: number) {
    if (!demoSessionWantedRef.current || generation !== demoConnectionGenerationRef.current) return;
    setDemoSocketStatus('CONNECTING');
    setDerivDemoBusy(true);
    setDerivDemoMessage('Requesting a fresh one-time Deriv demo WebSocket URL…');
    try {
      const response = await fetch('/api/deriv/demo/otp', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account_id: accountId }),
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401 || response.status === 403 || result.reconnect_required) {
        demoSessionWantedRef.current = false;
        demoAutoTradingRef.current = false;
        setDemoAutoTrading(false);
        setDerivDemoConnected(false);
        setDemoSocketStatus('ERROR');
        setDerivDemoBusy(false);
        setDerivDemoMessage('Deriv authorization expired or the selected account is no longer eligible. Reconnect Deriv OAuth and select a verified demo account.');
        setDemoTradeMessage('Demo bot paused because Deriv authorization must be renewed. No pending purchase will be replayed.');
        return;
      }
      if (!response.ok || !result.websocket_url) throw new Error(result.error || 'Could not obtain a fresh demo WebSocket URL.');
      if (!demoSessionWantedRef.current || generation !== demoConnectionGenerationRef.current) return;

      const previousSocket = demoWs.current;
      if (previousSocket) {
        previousSocket.onclose = null;
        previousSocket.close();
      }
      const socket = new WebSocket(result.websocket_url);
      demoWs.current = socket;
      demoConnectTimeoutRef.current = window.setTimeout(() => {
        if (demoWs.current === socket && socket.readyState === WebSocket.CONNECTING) {
          console.warn('[DERIV DEMO] WebSocket handshake timed out');
          socket.close(4002, 'Demo connection timeout');
        }
      }, 15000);
      socket.onopen = () => {
        if (demoConnectTimeoutRef.current) window.clearTimeout(demoConnectTimeoutRef.current);
        demoConnectTimeoutRef.current = undefined;
        if (!demoSessionWantedRef.current || generation !== demoConnectionGenerationRef.current || demoWs.current !== socket) {
          socket.close();
          return;
        }
        demoReconnectAttemptRef.current = 0;
        setDerivDemoMessage('DEMO WEBSOCKET CONNECTED · NO REAL FUNDS');
        setDemoSocketStatus('CONNECTED');
        setDemoTradeMessage('Demo order channel ready. Start a Differs or Matches demo session from the Engine page.');
        setDerivDemoBusy(false);

        // Keep the authenticated channel alive; every reconnect obtains a new OTP.
        if (demoHeartbeatIntervalRef.current) window.clearInterval(demoHeartbeatIntervalRef.current);
        if (demoHeartbeatTimeoutRef.current) window.clearTimeout(demoHeartbeatTimeoutRef.current);
        demoHeartbeatAwaitingRef.current = false;
        demoHeartbeatIntervalRef.current = window.setInterval(() => {
          if (demoWs.current !== socket || socket.readyState !== WebSocket.OPEN || demoHeartbeatAwaitingRef.current) return;
          demoHeartbeatAwaitingRef.current = true;
          const pingId = demoHeartbeatReqIdRef.current++;
          try {
            socket.send(JSON.stringify({ ping: 1, req_id: pingId }));
            demoHeartbeatTimeoutRef.current = window.setTimeout(() => {
              if (demoWs.current === socket && demoHeartbeatAwaitingRef.current && socket.readyState === WebSocket.OPEN) {
                console.warn('[DERIV DEMO] Heartbeat timed out; reconnecting');
                socket.close(4000, 'Demo heartbeat timeout');
              }
            }, 15000);
          } catch {
            socket.close(4001, 'Demo heartbeat send failed');
          }
        }, 60000);

        // Restore settlement subscriptions for known open demo contracts after reconnect.
        for (const trade of demoTradeMapRef.current.values()) {
          if (trade.accountId === accountId && trade.status === 'OPEN') {
            try {
              socket.send(JSON.stringify({
                proposal_open_contract: 1,
                contract_id: Number(trade.contractId),
                subscribe: 1,
                req_id: demoRequestIdRef.current++,
              }));
            } catch (error) {
              console.error('[DERIV DEMO] Could not restore contract subscription', error);
            }
          }
        }
      };
      socket.onerror = () => {
        if (demoWs.current !== socket || generation !== demoConnectionGenerationRef.current) return;
        setDerivDemoMessage('Demo WebSocket transport error. Reconnecting with a fresh authorization URL…');
        setDemoSocketStatus('ERROR');
        socket.close();
      };
      socket.onclose = (event) => {
        if (demoWs.current !== socket || generation !== demoConnectionGenerationRef.current) return;
        demoWs.current = null;
        if (demoConnectTimeoutRef.current) window.clearTimeout(demoConnectTimeoutRef.current);
        demoConnectTimeoutRef.current = undefined;
        if (demoHeartbeatIntervalRef.current) window.clearInterval(demoHeartbeatIntervalRef.current);
        if (demoHeartbeatTimeoutRef.current) window.clearTimeout(demoHeartbeatTimeoutRef.current);
        demoHeartbeatIntervalRef.current = undefined;
        demoHeartbeatTimeoutRef.current = undefined;
        demoHeartbeatAwaitingRef.current = false;

        // Never replay an uncertain buy. If its acknowledgement was lost, pause the bot
        // and reconnect only to restore monitoring; this avoids duplicate purchases.
        const uncertainBuy = [...demoOrderRequestsRef.current.values()].some(request => request.kind === 'buy');
        for (const timer of demoOrderTimeoutsRef.current.values()) window.clearTimeout(timer);
        demoOrderTimeoutsRef.current.clear();
        demoOrderRequestsRef.current.clear();
        if (uncertainBuy) {
          demoAutoTradingRef.current = false;
          setDemoAutoTrading(false);
          setDemoTradeMessage('Connection dropped while a purchase acknowledgement was pending. Bot paused to prevent a duplicate; verify the Deriv demo account contract history.');
        }
        if (!demoSessionWantedRef.current || generation !== demoConnectionGenerationRef.current) {
          setDemoSocketStatus('DISCONNECTED');
          setDerivDemoMessage('Deriv demo WebSocket disconnected');
          return;
        }
        console.warn('[DERIV DEMO] WebSocket closed', { code: event.code, reason: event.reason, wasClean: event.wasClean });
        scheduleDemoReconnect(accountId, generation, event.reason || `close code ${event.code}`);
      };
      socket.onmessage = (event) => {
        if (demoWs.current !== socket || generation !== demoConnectionGenerationRef.current) return;
        let data: any;
        try { data = JSON.parse(event.data); } catch { return; }
        const reqId = Number(data.req_id);
        if (data.msg_type === 'ping' && demoHeartbeatAwaitingRef.current) {
          demoHeartbeatAwaitingRef.current = false;
          if (demoHeartbeatTimeoutRef.current) window.clearTimeout(demoHeartbeatTimeoutRef.current);
          demoHeartbeatTimeoutRef.current = undefined;
          return;
        }
        if (data.error) {
          const failedRequest = demoOrderRequestsRef.current.get(reqId);
          if (Number.isInteger(reqId)) {
            clearDemoOrderTimeout(reqId);
            demoOrderRequestsRef.current.delete(reqId);
          }
          const message = String(data.error.message || data.error.code || 'Unknown API error');
          if (failedRequest?.kind === 'buy') {
            demoAutoTradingRef.current = false;
            setDemoAutoTrading(false);
            setDemoTradeMessage('Deriv rejected the demo BUY request: ' + message + '. Bot paused; no automatic retry was attempted.');
          } else {
            setDemoTradeMessage('Deriv rejected the demo ' + (failedRequest?.kind || 'request') + ': ' + message);
          }
          return;
        }
        if (data.msg_type === 'proposal' && data.proposal) {
          const request = demoOrderRequestsRef.current.get(reqId);
          if (!request || request.kind !== 'proposal') return;
          clearDemoOrderTimeout(reqId);
          demoOrderRequestsRef.current.delete(reqId);
          if (!demoAutoTradingRef.current || openDemoContractRef.current || demoDailyPnlRef.current >= settingsRef.current.takeProfitLimit || demoDailyPnlRef.current - settingsRef.current.stake < -settingsRef.current.dailyLossLimit - 1e-9) {
            setDemoTradeMessage('Demo purchase cancelled because the bot was stopped or the next full stake would exceed the daily loss limit.');
            return;
          }
          const proposalId = String(data.proposal.id || '');
          const askPrice = Number(data.proposal.ask_price);
          if (!proposalId || !Number.isFinite(askPrice) || askPrice <= 0) {
            setDemoTradeMessage('Deriv returned an invalid demo proposal; no purchase was sent.');
            return;
          }
          const payout = Number(data.proposal.payout);
          const evidence = getWalkForwardEvidence(request.symbol, ticksBySymbolRef.current.get(request.symbol) || [], request.strategy, settingsRef.current.windowSize);
          if (!evidence || evidence.testTrades < 100 || !Number.isFinite(payout) || payout <= askPrice) {
            setDemoTradeMessage(`Quote rejected: insufficient historical walk-forward evidence (${evidence?.testTrades ?? 0}/100 test predictions) or invalid payout. No purchase was sent.`);
            return;
          }
          const conservativeWinProbability = wilsonLowerBound(evidence.wins, evidence.testTrades);
          const conservativeExpectedValue = conservativeWinProbability * payout - askPrice;
          if (!(conservativeExpectedValue > 0)) {
            setDemoTradeMessage(`No purchase: conservative estimated value is ${conservativeExpectedValue.toFixed(4)} ${demoCurrencyRef.current} at ${(conservativeWinProbability * 100).toFixed(2)}% lower-bound win probability.`);
            return;
          }
          const buyReqId = demoRequestIdRef.current++;
          demoOrderRequestsRef.current.set(buyReqId, { ...request, kind: 'buy', proposalId, askPrice });
          armDemoOrderTimeout(buyReqId, 'buy', 15000);
          try {
            socket.send(JSON.stringify({ buy: proposalId, price: askPrice, req_id: buyReqId }));
            setDemoTradeMessage('Fresh quote received. Submitting demo purchase…');
          } catch {
            clearDemoOrderTimeout(buyReqId);
            demoOrderRequestsRef.current.delete(buyReqId);
            demoAutoTradingRef.current = false;
            setDemoAutoTrading(false);
            setDemoTradeMessage('Purchase could not be sent. Bot paused; no automatic retry was attempted.');
          }
          return;
        }
        if (data.msg_type === 'buy' && data.buy) {
          const request = demoOrderRequestsRef.current.get(reqId);
          if (!request || request.kind !== 'buy') return;
          clearDemoOrderTimeout(reqId);
          demoOrderRequestsRef.current.delete(reqId);
          const contractId = String(data.buy.contract_id || '');
          if (!/^\d+$/.test(contractId)) {
            setDemoTradeMessage('Deriv did not return a valid contract ID.');
            return;
          }
          openDemoContractRef.current = contractId;
          const trade: DemoDigitTrade = {
            contractId, accountId, symbol: request.symbol, strategy: request.strategy,
            targetDigit: request.targetDigit,
            stake: Number(data.buy.buy_price ?? request.askPrice ?? settingsRef.current.stake),
            status: 'OPEN', pnl: 0, openedAt: Date.now(),
          };
          demoTradeMapRef.current.set(contractId, trade);
          setDemoTrades(previous => [...previous.filter(item => item.contractId !== contractId), trade].slice(-200));
          socket.send(JSON.stringify({
            proposal_open_contract: 1, contract_id: Number(contractId), subscribe: 1,
            req_id: demoRequestIdRef.current++,
          }));
          setDemoTradeMessage('DEMO CONTRACT OPEN · waiting for Deriv settlement.');
          return;
        }
        if (data.msg_type === 'proposal_open_contract' && data.proposal_open_contract) {
          const contract = data.proposal_open_contract;
          const contractId = String(contract.contract_id || '');
          const previous = demoTradeMapRef.current.get(contractId);
          if (!previous) return;
          const hasProfit = contract.profit !== undefined && contract.profit !== null && Number.isFinite(Number(contract.profit));
          const profit = hasProfit ? Number(contract.profit) : previous.pnl;
          const closed = Boolean(contract.is_sold) || ['won', 'lost', 'sold', 'expired'].includes(String(contract.status || '').toLowerCase());
          const next: DemoDigitTrade = {
            ...previous, pnl: profit,
            status: closed ? String(contract.status || 'SETTLED').toUpperCase() : 'OPEN',
            closedAt: closed ? (previous.closedAt || Date.now()) : undefined,
          };
          demoTradeMapRef.current.set(contractId, next);
          setDemoTrades(items => items.map(item => item.contractId === contractId ? next : item));
          if (closed && previous.status === 'OPEN') {
            if (openDemoContractRef.current === contractId) openDemoContractRef.current = null;
            if (hasProfit) {
              const nextDailyPnl = demoDailyPnlRef.current + profit;
              demoDailyPnlRef.current = nextDailyPnl;
              setDemoDailyPnl(nextDailyPnl);
              try {
                localStorage.setItem(`${DEMO_DAILY_KEY}:${previous.accountId}`, JSON.stringify({
                  day: new Date().toISOString().slice(0, 10), pnl: nextDailyPnl,
                }));
              } catch {}
              if (nextDailyPnl <= -settingsRef.current.dailyLossLimit) {
                demoAutoTradingRef.current = false;
                setDemoAutoTrading(false);
                setDemoTradeMessage('Demo daily loss limit reached. Automatic demo trading stopped.');
                return;
              }
              if (nextDailyPnl >= settingsRef.current.takeProfitLimit) {
                demoAutoTradingRef.current = false;
                setDemoAutoTrading(false);
                setDemoTradeMessage('Demo daily profit target reached. Automatic demo trading stopped.');
                return;
              }
            }
            setDemoTradeMessage('Demo contract settled. Actual Deriv profit/loss recorded in the local journal.');
          }
        }
      };
      setDerivDemoMessage('Connecting to verified demo account…');
    } catch (error) {
      setDerivDemoBusy(false);
      const message = error instanceof Error ? error.message : 'Demo connection failed.';
      if (demoSessionWantedRef.current && generation === demoConnectionGenerationRef.current) {
        scheduleDemoReconnect(accountId, generation, message);
      } else {
        setDerivDemoMessage(message);
        setDemoSocketStatus('ERROR');
      }
    }
  }

  async function openDerivDemoSession() {
    if (!selectedDemoAccountId) return;
    const accountId = selectedDemoAccountId;
    demoSessionWantedRef.current = true;
    const generation = ++demoConnectionGenerationRef.current;
    demoReconnectAttemptRef.current = 0;
    if (demoReconnectTimerRef.current) window.clearTimeout(demoReconnectTimerRef.current);
    setDerivDemoBusy(true);
    setDerivDemoMessage('Requesting short-lived demo session…');
    await connectDemoExecutionSocket(accountId, generation);
  }

  async function disconnectDerivDemo() {
    if (openDemoContractRef.current || demoOrderRequestsRef.current.size) { setDemoTradeMessage('Wait for pending orders and the open one-tick contract to settle before disconnecting.'); return; }
    demoSessionWantedRef.current = false;
    demoConnectionGenerationRef.current += 1;
    if (demoReconnectTimerRef.current) window.clearTimeout(demoReconnectTimerRef.current);
    if (demoHeartbeatIntervalRef.current) window.clearInterval(demoHeartbeatIntervalRef.current);
    if (demoHeartbeatTimeoutRef.current) window.clearTimeout(demoHeartbeatTimeoutRef.current);
    if (demoConnectTimeoutRef.current) window.clearTimeout(demoConnectTimeoutRef.current);
    demoReconnectTimerRef.current = undefined;
    demoHeartbeatIntervalRef.current = undefined;
    demoHeartbeatTimeoutRef.current = undefined;
    const activeSocket = demoWs.current;
    demoWs.current = null;
    if (activeSocket) { activeSocket.onclose = null; activeSocket.close(); }
    setDemoSocketStatus('DISCONNECTED');
    setDerivDemoBusy(true);
    try {
      demoAutoTradingRef.current = false;
      setDemoAutoTrading(false);
      demoSocketStatus === 'CONNECTED' && setDemoSocketStatus('DISCONNECTED');
      demoOrderRequestsRef.current.clear();
      demoWs.current = null;
      const response = await fetch('/api/deriv/demo/disconnect', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error('Could not disconnect Deriv.');
      setDerivDemoConnected(false);
      setDerivDemoAccounts([]);
      setSelectedDemoAccountId('');
      setDerivDemoMessage('Deriv demo account disconnected');
    } catch (error) {
      setDerivDemoMessage(error instanceof Error ? error.message : 'Disconnect failed.');
    } finally { setDerivDemoBusy(false); }
  }

  const validSettings = settings.stake > 0 && settings.stake <= 1000 && settings.dailyLossLimit > 0 && settings.dailyLossLimit <= 10000 && settings.takeProfitLimit > 0 && settings.takeProfitLimit <= 10000 && Number.isInteger(settings.windowSize) && settings.windowSize >= 50 && settings.windowSize <= 5000;

  function requestDemoDigitTrade(marketSymbol: string, strategy: ResearchStrategy, targetDigit: number) {
    const socket = demoWs.current;
    if (!demoAutoTradingRef.current || !socket || socket.readyState !== WebSocket.OPEN) return;
    if (marketSymbol !== selectedSymbolRef.current || strategy !== 'DIFFERS') return;
    const accountCurrency = demoCurrencyRef.current;
    if (!accountCurrency) { setDemoTradeMessage('Select a verified demo account with a known currency before trading.'); return; }
    if (openDemoContractRef.current || demoOrderRequestsRef.current.size) return;
    if (demoDailyPnlRef.current >= settingsRef.current.takeProfitLimit) { demoAutoTradingRef.current = false; setDemoAutoTrading(false); setDemoTradeMessage('Daily demo profit target already reached. Bot stopped.'); return; }
    if (demoDailyPnlRef.current - settingsRef.current.stake < -settingsRef.current.dailyLossLimit - 1e-9) { demoAutoTradingRef.current = false; setDemoAutoTrading(false); setDemoTradeMessage('Another full stake would exceed the daily loss limit. Bot stopped before requesting a quote.'); return; }
    const evidence = getWalkForwardEvidence(marketSymbol, ticksBySymbolRef.current.get(marketSymbol) || [], strategy, settingsRef.current.windowSize);
    if (!evidence || evidence.testTrades < 100) {
      setDemoTradeMessage(`Loading historical validation: ${evidence?.testTrades ?? 0}/100 out-of-sample predictions. No purchase will be sent until enough historical ticks are available.`);
      return;
    }
    if (Date.now() - demoLastOrderAtRef.current < 1000) return;
    if (!Number.isInteger(targetDigit) || targetDigit < 0 || targetDigit > 9) return;
    demoLastOrderAtRef.current = Date.now();
    const reqId = demoRequestIdRef.current++;
    demoOrderRequestsRef.current.set(reqId, { kind: 'proposal', symbol: marketSymbol, strategy, targetDigit });
    armDemoOrderTimeout(reqId, 'proposal', 12000);
    const contractType = strategy === 'DIFFERS' ? 'DIGITDIFF' : 'DIGITMATCH';
    try {
      socket.send(JSON.stringify({ proposal: 1, amount: settingsRef.current.stake, basis: 'stake', contract_type: contractType, currency: accountCurrency, duration: 1, duration_unit: 't', underlying_symbol: marketSymbol, barrier: String(targetDigit), req_id: reqId }));
      setDemoTradeMessage(`Requesting a fresh ${strategy} demo quote on ${marketSymbol}, target ${targetDigit}…`);
    } catch {
      clearDemoOrderTimeout(reqId);
      demoOrderRequestsRef.current.delete(reqId);
      demoAutoTradingRef.current = false;
      setDemoAutoTrading(false);
      setDemoTradeMessage('Could not send the demo proposal request. Bot paused; reconnect the demo execution socket.');
    }
  }

  function requestMarketProposal(marketSymbol: string, marketTicks?: Tick[]) {
    const currentSettings = settingsRef.current;
    const socket = ws.current;
    const accountCurrency = demoCurrencyRef.current;
    if (!accountCurrency || !socket || socket.readyState !== WebSocket.OPEN) return;
    const sourceTicks = marketTicks || ticksBySymbolRef.current.get(marketSymbol) || [];
    const digits = sourceTicks.slice(-currentSettings.windowSize).map((tick) => tick.lastDigit ?? digitFromQuote(tick.quote, tick.pipSize));
    if (digits.length < currentSettings.windowSize) return;
    const barrier = getStats(digits).barrier;
    if (barrier < 0) return;
    for (const [pendingId, pending] of proposalRequestsRef.current) {
      if (pending.symbol === marketSymbol) proposalRequestsRef.current.delete(pendingId);
    }
    const reqId = proposalReqIdRef.current++;
    proposalRequestsRef.current.set(reqId, { symbol: marketSymbol, barrier, currency: accountCurrency, stake: currentSettings.stake });
    socket.send(JSON.stringify({ proposal: 1, amount: currentSettings.stake, basis: 'stake', contract_type: 'DIGITDIFF', currency: accountCurrency, duration: 1, duration_unit: 't', underlying_symbol: marketSymbol, barrier: String(barrier), req_id: reqId }));
  }

  function subscribeMarket(marketSymbol: string) {
    const socket = ws.current;
    if (!marketSymbol || !socket || socket.readyState !== WebSocket.OPEN) return;
    // One selected-market stream avoids exhausting Deriv's subscription capacity.
    socket.send(JSON.stringify({ forget_all: 'ticks' }));
    socket.send(JSON.stringify({ ticks_history: marketSymbol, count: 5000, end: 'latest', style: 'ticks', req_id: 1000 }));
    socket.send(JSON.stringify({ ticks: marketSymbol, subscribe: 1, req_id: 2000 }));
  }

  const selectSymbol = (nextSymbol: string) => {
    if (demoAutoTradingRef.current || openDemoContractRef.current) return;
    if (nextSymbol === selectedSymbolRef.current) return;
    selectedSymbolRef.current = nextSymbol;
    setSymbol(nextSymbol);
    const nextTicks = ticksBySymbolRef.current.get(nextSymbol) || [];
    ticksRef.current = nextTicks;
    setTicks(nextTicks);
    setPipSize(pipSizesBySymbolRef.current.get(nextSymbol));
    subscribeMarket(nextSymbol);
  };

  useEffect(() => {
    if (!authenticated || !demoCurrency) { proposalRequestsRef.current.clear(); setProposalQuotes({}); return; }
    proposalRequestsRef.current.clear();
    setProposalQuotes({});
    let quoteTimer: number | undefined;
    const scheduleQuote = () => {
      if (quoteTimer) window.clearTimeout(quoteTimer);
      quoteTimer = window.setTimeout(() => requestMarketProposal(selectedSymbolRef.current), 500);
    };
    scheduleQuote();
    const timer = window.setInterval(() => {
      setProposalQuotes((previous) => Object.fromEntries(Object.entries(previous).filter(([, quote]) => Date.now() - quote.quotedAt <= 90000)));
      scheduleQuote();
    }, 60000);
    return () => { window.clearInterval(timer); if (quoteTimer) window.clearTimeout(quoteTimer); };
  }, [authenticated, symbol, demoCurrency, settings.stake, settings.windowSize]);

  const submitLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoginError('');
    try {
      const response = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: loginPassword }) });
      if (!response.ok) throw new Error(response.status === 401 ? 'Incorrect app password.' : 'Login service is not ready. Check backend configuration.');
      const savedResponse = await fetch('/api/settings', { credentials: 'same-origin', cache: 'no-store' });
      if (!savedResponse.ok) throw new Error('Login succeeded, but settings could not be loaded from Neon.');
      const remote = await savedResponse.json();
      setSettings({ stake: Number(remote.stake), dailyLossLimit: Number(remote.dailyLossLimit), takeProfitLimit: Number(remote.takeProfitLimit), windowSize: Number(remote.windowSize) });
      setSettingsLoaded(true);
      setAuthenticated(true);
      setLoginPassword('');
    } catch (reason) { setLoginError(reason instanceof Error ? reason.message : 'Login failed.'); }
  };

  const logout = async () => {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => undefined);
    setAuthenticated(false);
    setSettingsLoaded(false);
    setTicks([]);
    ticksRef.current = [];
  };

  if (authChecking) return <main className="login-shell"><section className="panel login-panel"><div className="eyebrow">LOTUS PRIVATE ACCESS</div><h1>Checking secure session</h1><p className="muted">{backendStatus}</p></section></main>;
  if (!authenticated) return <main className="login-shell"><form className="panel login-panel" onSubmit={submitLogin}><div className="lotus-mark" aria-hidden="true"><svg viewBox="0 0 180 110"><path d="M90 96C57 76 51 47 90 9C129 47 123 76 90 96Z"/><path d="M90 96C38 88 17 64 28 35C61 43 82 63 90 96Z"/><path d="M90 96C142 88 163 64 152 35C119 43 98 63 90 96Z"/><path d="M90 96C73 65 76 37 90 18C104 37 107 65 90 96Z"/></svg></div><div className="eyebrow">WELCOME TO</div><h1>LOTUS</h1><p className="muted">Deriv digit intelligence · research first</p><p className="muted">Use the private app password configured in your deployment's environment variables. This is not your Deriv API token.</p><label className="setting-field">App password<input type="password" autoComplete="current-password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} required /></label>{loginError && <div className="error" role="alert">{loginError}</div>}<button className="secondary-button" type="submit">Sign in</button><small className="muted">Backend: {backendStatus}</small></form></main>;

  return <main className={theme === 'light' ? 'theme-light' : 'theme-dark'}>
    <header className="topbar">
      <div><div className="eyebrow">LOTUS · DERIV SYNTHETICS</div><h1>Lotus</h1><p className="subhead">Digit trading terminal · live intelligence and demo execution</p></div>
      <div className="header-actions"><span className={status === 'CONNECTED' ? 'status online' : 'status'}><i />MARKET {status}</span><span className={derivDemoConnected ? "status online account-status" : "status account-status"}><i />{derivDemoConnected ? "DERIV AUTHORIZED · DEMO" : "DEMO ACCOUNT NOT LINKED"}</span><button className="secondary-button theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</button><button className="secondary-button" onClick={logout}>Sign out</button></div>
    </header>

    <nav className="tabs" aria-label="Main navigation">
      <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button>
      <button className={tab === 'engine' ? 'active' : ''} onClick={() => setTab('engine')}>Digit engines</button>
      <button className={tab === 'wins' ? 'active' : ''} onClick={() => setTab('wins')}>Wins</button>
      <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>Journal</button>
      <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Settings</button>
    </nav>

    <section className="mode-banner">
      <span className={status === 'CONNECTED' ? 'mode-light active' : 'mode-light'} />
      <div><strong>LOTUS ENGINE</strong><small>{status === 'CONNECTED' ? 'LIVE MARKET FEED · RESEARCH MODE' : 'HISTORICAL MODE · LAST AVAILABLE DATA'}</small></div>
      <span className="execution-lock">{demoAutoTrading ? 'DEMO BOT ARMED' : demoSocketStatus === 'CONNECTED' ? 'DEMO CHANNEL READY' : 'DEMO EXECUTION DISARMED'}</span>
    </section>
    {error && <div className="error" role="alert">{error}</div>}

    {tab === 'overview' && <>
      <section className="overview-intro">
        <div><div className="section-heading">LOTUS COMMAND CENTRE</div><h2>Trading performance</h2><p className="muted">Realized demo results, market leaders and the current execution state.</p></div>
        <span className="execution-lock">{demoAutoTrading ? 'DEMO AUTOMATION ACTIVE' : 'DEMO MODE'}</span>
      </section>
<section className="overview-money-grid">
        <div className="panel money-card money-primary"><span>REALIZED DEMO P/L</span><strong className={demoRealizedPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>{demoRealizedPnl >= 0 ? '+' : ''}{demoRealizedPnl.toFixed(2)} {demoCurrency}</strong><small>Settled contracts recorded in this browser for the selected demo account</small></div>
        <div className="panel money-card"><span>DEMO BALANCE</span><strong>{selectedDemoAccount?.balance == null ? '—' : selectedDemoAccount.balance.toFixed(2) + ' ' + demoCurrency}</strong><small>{selectedDemoAccount ? 'Last balance returned by Deriv' : 'Connect a verified demo account'}</small></div>
        <div className="panel money-card"><span>DEMO WIN RATE</span><strong>{demoWinRate === null ? '—' : demoWinRate.toFixed(1) + '%'}</strong><small>{demoWinningTrades} wins from {settledDemoTrades.length} settled demo contracts</small></div>
        <div className="panel money-card"><span>TOP MONEY-MAKING MARKET</span><strong>{overviewDemoMarketLeaders[0]?.name || '—'}</strong><small>{overviewDemoMarketLeaders[0] ? (overviewDemoMarketLeaders[0].pnl >= 0 ? '+' : '') + overviewDemoMarketLeaders[0].pnl.toFixed(2) + ' ' + demoCurrency + ' · ' + overviewDemoMarketLeaders[0].trades + ' settled' : 'No settled market results yet'}</small></div>
        <div className="panel money-card"><span>SETTLED DEMO CONTRACTS</span><strong>{settledDemoTrades.length.toLocaleString()}</strong><small>{accountDemoTrades.filter(trade => trade.status === 'OPEN').length} currently open · {accountDemoTrades.length} recorded</small></div>
      </section>
            <section className="overview-grid">
        <div className="panel"><div className="panel-title"><div><div className="section-heading">DEMO P/L LEADERS</div><p className="muted">Markets ranked by recorded realized demo profit, not paper hit rate.</p></div></div>
          {overviewDemoMarketLeaders.length ? <div className="table-wrap"><table><thead><tr><th>Market</th><th>Realized P/L</th><th>Win rate</th><th>Trades</th></tr></thead><tbody>{overviewDemoMarketLeaders.slice(0,5).map(row=><tr key={row.symbol}><td><button className="text-button" onClick={()=>selectSymbol(row.symbol)}>{row.name}</button></td><td className={row.pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>{row.pnl >= 0 ? '+' : ''}{row.pnl.toFixed(2)} {demoCurrency}</td><td>{(row.wins/row.trades*100).toFixed(1)}%</td><td>{row.trades}</td></tr>)}</tbody></table></div> : <p className="empty-state">No settled demo contracts yet. Demo P/L leaders will appear here after contract settlements are recorded.</p>}
        </div>
        <div className="panel"><div className="section-heading">LIVE SESSION</div>
          <div className="candidate-row"><span>Selected market</span><strong>{marketName}</strong></div><div className="candidate-row"><span>Latest quote</span><strong>{ticks.at(-1)?.quote ?? '—'}</strong></div><div className="candidate-row"><span>Last digit</span><strong>{digits.at(-1) ?? '—'}</strong></div><div className="candidate-row"><span>Live feed</span><strong>{status}</strong></div><div className="candidate-row"><span>Demo execution</span><strong>{demoSocketStatus}</strong></div><div className="candidate-row"><span>Bot state</span><strong>{demoAutoTrading ? 'ARMED' : 'STOPPED'}</strong></div>
          <button className="secondary-button" onClick={()=>setTab('settings')}>Account and risk settings</button>
        </div>
      </section>
      <section className="panel market-scanner"><div className="panel-title"><div><div className="section-heading">DIGIT MARKET LEADERS</div><p className="muted">Historical Differs research across eligible markets. Live ticks and quotes follow the selected market only; select a row to switch the stream.</p></div><span className="live-dot">{demoCurrency ? 'SELECTED-MARKET QUOTE' : 'CONNECT DEMO ACCOUNT'}</span></div>
        {highestWinRateMarket && <div className="scanner-leader"><span>Highest observed hit rate · minimum 100 settled paper outcomes</span><strong>{highestWinRateMarket.name}</strong><small>{(highestWinRateMarket.winRate! * 100).toFixed(2)}% from {highestWinRateMarket.total} outcomes</small></div>}
        {bestMarket ? <div className="scanner-leader"><span>Best conservative-EV research candidate</span><strong>{bestMarket.name}</strong><small>{(bestMarket.winRate! * 100).toFixed(2)}% observed hit rate · barrier {bestMarket.quote!.barrier} · {(bestMarket.conservativeWinRate! * 100).toFixed(2)}% 95% lower bound · +{bestMarket.conservativeEv!.toFixed(4)} {demoCurrency} estimated EV per contract</small></div> : <p className="muted">No market currently passes the quote and sample-size research gates. A positive paper estimate would still not establish future profitability.</p>}
        <div className="table-wrap"><table><thead><tr><th>Market</th><th>Barrier</th><th>Settled / matched</th><th>Hit rate</th><th>95% lower bound</th><th>Ask / payout</th><th>Estimated EV</th></tr></thead><tbody>{scannerRows.map(row=><tr key={row.symbol}><td><button className="text-button" onClick={()=>selectSymbol(row.symbol)}>{row.name}</button></td><td>{row.quote ? row.quote.barrier : '—'}</td><td>{row.total} / {row.matchedSample}</td><td>{row.winRate === null ? '—' : (row.winRate*100).toFixed(2)+'%'}</td><td>{row.conservativeWinRate === null ? '—' : (row.conservativeWinRate*100).toFixed(2)+'%'}</td><td>{row.quote ? `${row.quote.askPrice.toFixed(4)} / ${row.quote.payout.toFixed(4)}` : 'Waiting'}</td><td>{row.conservativeEv === null ? '—' : `${row.conservativeEv>=0?'+':''}${row.conservativeEv.toFixed(4)} ${demoCurrency}`}</td></tr>)}{!scannerRows.length && <tr><td colSpan={7} className="empty">Waiting for eligible Differs markets…</td></tr>}</tbody></table></div>
        <small className="muted">Estimated EV uses the Wilson 95% lower-bound paper hit rate for the quoted barrier. It is not realized P/L and does not correct for serial dependence or selection bias.</small>
      </section>
      <section className="panel"><div className="panel-title"><div><div className="section-heading">CURRENT MARKET DIGIT STREAM</div><p className="muted">{marketName} · latest 60 final quote digits</p></div><span className="live-dot">LIVE FEED</span></div><div className="digits">{digits.slice(-60).map((digit,index,array)=><span key={ticks.slice(-60)[index]?.id ?? index} className={index===array.length-1?'last':''}>{digit}</span>)}</div></section>
      <section className="stats-grid"><Metric label={settings.windowSize+'-tick sample'} value={stats.sample.toString()} /><Metric label="Shannon entropy" value={stats.sample?stats.entropy.toFixed(3):'—'} /><Metric label="All-session ticks" value={digits.length.toLocaleString()} /><Metric label="Out-of-sample edge" value="Not established" /></section>
    </>}
    {tab === 'engine' && <>
      <section className="panel engine-hero">
        <div className="section-heading">DIGIT EXECUTION COCKPIT</div><h2>Choose your trading engine</h2>
        <p className="muted">Live target selection is driven by the rolling digit window. Demo purchases are DIFFERS-only and gated by chronological walk-forward results plus a fresh payout-adjusted quote. A failed gate blocks the purchase; it is not bypassed.</p>
        <div className="strategy-switch">
          <button className={activeStrategy === 'DIFFERS' ? 'selected' : ''} disabled={demoAutoTrading || Boolean(openDemoContractRef.current)} onClick={() => { setActiveStrategy('DIFFERS'); setAnalysisRunning(false); }}>DIFFERS<small>Next digit is not the target</small></button>
          <button className={activeStrategy === 'MATCHES' ? 'selected' : ''} disabled={demoAutoTrading || Boolean(openDemoContractRef.current)} onClick={() => { setActiveStrategy('MATCHES'); setAnalysisRunning(false); }}>MATCHES<small>Next digit equals the target</small></button>
          <button className={activeStrategy === 'EVEN' ? 'selected' : ''} disabled={demoAutoTrading || Boolean(openDemoContractRef.current)} onClick={() => { setActiveStrategy('EVEN'); setAnalysisRunning(false); }}>EVEN<small>Next digit is even</small></button>
          <button className={activeStrategy === 'ODD' ? 'selected' : ''} disabled={demoAutoTrading || Boolean(openDemoContractRef.current)} onClick={() => { setActiveStrategy('ODD'); setAnalysisRunning(false); }}>ODD<small>Next digit is odd</small></button>
        </div>
        <div className="research-signal">
          <span className="section-heading">{activeStrategy} · {marketName}</span>
          <div className="signal-digit">{activeStrategy === 'DIFFERS' ? (stats.barrier >= 0 ? stats.barrier : '—') : activeStrategy === 'MATCHES' ? (stats.sample ? stats.counts.indexOf(Math.max(...stats.counts)) : '—') : activeStrategy}</div>
          <div className="signal-label">{activeStrategy === 'EVEN' || activeStrategy === 'ODD' ? 'PREDICTED PARITY' : 'TARGET DIGIT'}</div><div className="confidence-track"><i style={{ width: (stats.sample ? Math.min(100, (activeStrategy === 'DIFFERS' ? 1 - stats.barrierRate : activeStrategy === 'MATCHES' ? Math.max(...stats.probabilities) : rollingDigits.filter(digit => activeStrategy === 'EVEN' ? digit % 2 === 0 : digit % 2 === 1).length / stats.sample) * 100) : 0) + '%' }} /></div>
          <div className="candidate-row"><span>Prior-window frequency estimate · not a win probability</span><strong>{stats.sample ? ((activeStrategy === 'DIFFERS' ? 1 - stats.barrierRate : activeStrategy === 'MATCHES' ? Math.max(...stats.probabilities) : rollingDigits.filter(digit => activeStrategy === 'EVEN' ? digit % 2 === 0 : digit % 2 === 1).length / stats.sample) * 100).toFixed(2) + '%' : '—'}</strong></div>
          <div className="candidate-row"><span>Historical sample</span><strong>{stats.sample} / {settings.windowSize}</strong></div>
          <div className="candidate-row"><span>Model confidence</span><strong>Not calibrated</strong></div>
          <p className="muted">Differs selects the least-frequent digit; Matches selects the most-frequent digit. These are rolling-frequency heuristics, not calibrated probabilities. MATCHES, EVEN and ODD are research-only; only DIFFERS can request a demo purchase, and only when its out-of-sample, payout-adjusted gate passes.</p>
        </div>
        <div className="control-row research-controls">
          <button className="start-button" onClick={() => setAnalysisRunning(true)} disabled={analysisRunning || stats.sample < settings.windowSize}>START {activeStrategy} ANALYSIS</button>
          <button className="stop-button" onClick={() => setAnalysisRunning(false)} disabled={!analysisRunning}>STOP ANALYSIS</button>
        </div>
        <small className="lock-note">{analysisRunning ? activeStrategy + ' paper research running' : 'Research feed remains connected · start an engine to journal paper choices'}</small>
      </section>
      <section className="panel demo-execution-panel">
        <div className="panel-title"><div><div className="section-heading">DEMO CONTRACT EXECUTION</div><p className="muted">Actual one-tick DIFFERS demo contracts only. MATCHES remains research-only until it demonstrates a reliable out-of-sample edge. Real accounts are not supported.</p></div><span className="demo-execution-badge">DEMO ONLY</span></div>
        <div className="candidate-row"><span>Selected demo account</span><strong>{selectedDemoAccountId || 'Not selected'}</strong></div>
        <div className="candidate-row"><span>Demo currency</span><strong>{demoCurrency || 'Unavailable'}</strong></div>
        <div className="candidate-row"><span>Execution socket</span><strong>{demoSocketStatus}</strong></div>
        <div className="candidate-row"><span>Strategy / market</span><strong>{activeStrategy} · {marketName}</strong></div>
        <div className="candidate-row"><span>Stake per contract</span><strong>{settings.stake.toFixed(2)} {demoCurrency}</strong></div>
        <div className="candidate-row"><span>Realized demo P/L today</span><strong>{demoDailyPnl.toFixed(2)} {demoCurrency}</strong></div>
        <div className="candidate-row"><span>Daily loss stop</span><strong>{settings.dailyLossLimit.toFixed(2)} {demoCurrency}</strong></div>
        <div className="candidate-row"><span>Daily profit target</span><strong>{settings.takeProfitLimit.toFixed(2)} {demoCurrency}</strong></div>
        <div className="demo-execution-actions">
          <button className="secondary-button" disabled={!derivDemoConnected || !selectedDemoAccountId || demoSocketStatus === 'CONNECTING' || demoSocketStatus === 'CONNECTED' || derivDemoBusy} onClick={openDerivDemoSession}>CONNECT DEMO EXECUTION</button>
          <button className="start-button" disabled={demoAutoTrading || Boolean(openDemoContractRef.current) || demoOrderRequestsRef.current.size > 0 || demoSocketStatus !== 'CONNECTED' || !demoCurrency || activeStrategy !== 'DIFFERS' || status !== 'CONNECTED' || stats.sample < settings.windowSize || demoDailyPnl >= settings.takeProfitLimit || demoDailyPnl - settings.stake < -settings.dailyLossLimit - 1e-9} onClick={() => { demoAutoTradingRef.current = true; setDemoAutoTrading(true); setAnalysisRunning(true); setDemoTradeMessage(`Demo ${activeStrategy} bot armed on ${marketName}. Checking historical walk-forward evidence and waiting for the next eligible quote.`); }}>START DEMO BOT</button>
          <button className="stop-button" disabled={!demoAutoTrading} onClick={() => { demoAutoTradingRef.current = false; for (const [id, request] of demoOrderRequestsRef.current) if (request.kind === 'proposal') demoOrderRequestsRef.current.delete(id); setDemoAutoTrading(false); setDemoTradeMessage('Demo bot stopped. Any submitted buy or open one-tick contract remains with Deriv until settlement.'); }}>STOP DEMO BOT</button>
        </div>
        <p className="muted" aria-live="polite">{demoAutoTrading ? 'AUTOMATION ARMED · DEMO ACCOUNT ONLY' : 'AUTOMATION DISARMED'} · {demoTradeMessage}</p>
        <div className="table-wrap"><table><thead><tr><th>Opened</th><th>Market</th><th>Engine</th><th>Target</th><th>Stake</th><th>Status</th><th>Demo P/L</th></tr></thead><tbody>
          {[...demoTrades.filter(trade => trade.accountId === selectedDemoAccountId)].reverse().slice(0,10).map(trade => <tr key={trade.contractId}><td>{new Date(trade.openedAt).toLocaleTimeString()}</td><td>{trade.symbol}</td><td>{trade.strategy}</td><td>{trade.targetDigit}</td><td>{trade.stake.toFixed(2)}</td><td>{trade.status}</td><td>{trade.pnl.toFixed(2)}</td></tr>)}
          {!demoTrades.some(trade => trade.accountId === selectedDemoAccountId) && <tr><td colSpan={7} className="empty">No demo purchases yet. Connect a demo execution session, choose Differs or Matches, then start the demo bot.</td></tr>}
        </tbody></table></div>
        <small className="muted">Controls: one open contract at a time, 1-second cooldown and browser-enforced daily loss and profit stops. Historical walk-forward validation uses the already-loaded tick history; it does not wait for 100 new live paper outcomes. The bot runs only while this dashboard remains open. These controls are demo safeguards, not server-enforced live risk controls. Even/Odd remains research-only.</small>
      </section>


    </>}

    {tab === 'wins' && <>
      <section className="stats-grid wins-grid">{(['DIFFERS','MATCHES','EVEN','ODD'] as ResearchStrategy[]).map(strategy => { const rows = researchDecisions.filter(item => item.strategy === strategy && item.correct !== null); const wins = rows.filter(item => item.correct).length; return <div className="panel metric-card" key={strategy}><span>{strategy} PAPER WIN RATE</span><strong>{rows.length ? (wins / rows.length * 100).toFixed(2) + '%' : '—'}</strong><small>{wins} wins · {rows.length - wins} losses · {rows.length} settled</small></div>; })}</section>
      <section className="overview-grid"><div className="panel metric-card"><span>VERIFIED LIVE P/L</span><strong>—</strong><small>Unavailable: live trading is disabled.</small></div><div className="panel metric-card"><span>LIVE ACCOUNT WIN RATE</span><strong>—</strong><small>No live contracts have been executed or settled.</small></div></section>
      <section className="panel">
        <div className="section-heading">HISTORICAL WALK-FORWARD BACKTEST</div>
        <p className="muted">Replays the selected market chronologically. Each decision sees only the preceding rolling window. The first 70% warms the process; the final 30% is the untouched chronological test segment.</p>
        <div className="settings-actions">
          <label className="setting-field">Strategy
            <select value={backtestStrategy} onChange={event => setBacktestStrategy(event.target.value as ResearchStrategy)}>
              <option value="DIFFERS">Differs</option><option value="MATCHES">Matches</option><option value="EVEN">Even</option><option value="ODD">Odd</option>
            </select>
          </label>
          <button className="secondary-button" onClick={() => {
            const marketTicks = ticksBySymbolRef.current.get(symbol) || [];
            const digits = marketTicks.map(tick => Number.isInteger(tick.lastDigit) ? Number(tick.lastDigit) : digitFromQuote(tick.quote, tick.pipSize));
            try { setBacktestResult(runWalkForwardBacktest(digits, backtestStrategy, settings.windowSize)); }
            catch (error) { setError(error instanceof Error ? error.message : 'Backtest failed.'); }
          }}>RUN HISTORICAL BACKTEST</button>
        </div>
        {backtestResult && <>
          <div className="stats-grid wins-grid">
            <div className="panel metric-card"><span>TEST TRADES</span><strong>{backtestResult.testTrades}</strong><small>{backtestResult.warmupTicks} warm-up ticks · {backtestResult.totalTicks} total</small></div>
            <div className="panel metric-card"><span>TEST HIT RATE</span><strong>{backtestResult.winRate === null ? '—' : (backtestResult.winRate * 100).toFixed(2) + '%'}</strong><small>{backtestResult.wins} wins · {backtestResult.losses} losses</small></div>
            <div className="panel metric-card"><span>THEORETICAL BASELINE</span><strong>{(backtestResult.theoreticalBaseline * 100).toFixed(1)}%</strong><small>Difference: {backtestResult.differenceFromBaseline === null ? '—' : (backtestResult.differenceFromBaseline * 100).toFixed(2) + ' pp'}</small></div>
            <div className="panel metric-card"><span>MAX LOSS STREAK</span><strong>{backtestResult.maxConsecutiveLosses}</strong><small>{backtestResult.strategy} · {backtestResult.windowSize}-tick window</small></div>
          </div>
          <p className="muted">{backtestResult.note}</p>
        </>}
      </section>
      <section className="panel"><div className="section-heading">PAPER PERFORMANCE BY ENGINE</div><div className="table-wrap"><table><thead><tr><th>Engine</th><th>Settled</th><th>Wins</th><th>Losses</th><th>Win rate</th></tr></thead><tbody>{(['DIFFERS','MATCHES','EVEN','ODD'] as ResearchStrategy[]).map(strategy => { const rows = researchDecisions.filter(item => item.strategy === strategy && item.correct !== null); const wins = rows.filter(item => item.correct).length; return <tr key={strategy}><td>{strategy}</td><td>{rows.length}</td><td>{wins}</td><td>{rows.length-wins}</td><td>{rows.length ? (wins/rows.length*100).toFixed(2)+'%' : '—'}</td></tr>; })}</tbody></table></div><p className="muted">Paper win rate is not net profitability. Contract payout, stake, fees and realized settlement are not included.</p></section>
    </>}

    {tab === 'activity' && <>
      <section className="accuracy-strip" aria-live="polite">
        <div><span className="section-heading">LIVE CHOICE ACCURACY</span><small>One-tick paper outcomes · {symbol}</small></div>
        <strong>{settledAccuracy === null ? '—' : settledAccuracy.toFixed(1) + '%'}</strong>
        <span className="accuracy-sample">{symbolOutcomes.length} settled {symbolOutcomes.length === 1 ? 'choice' : 'choices'}</span>
      </section>
      <p className="accuracy-note">Each choice selects the least-frequent digit using the preceding analysis window. It is scored against the next live tick only. This is a paper prediction statistic, not actual contract win rate, net profitability, or a guarantee. Settled paper choices are saved in Neon; the browser cache is only a convenience.</p>
      <section className="panel">
        <div className="section-heading">ROLLING DIGIT DISTRIBUTION</div>
        <p className="muted">Observed frequencies over the latest {stats.sample} ticks. Frequency alone does not establish a predictive edge.</p>
        <div className="bars">{stats.counts.map((count, digit) => <div className="bar-row" key={digit}><span>{digit}</span><div className="bar-track"><i style={{ width: stats.sample ? (count / stats.sample * 100) + '%' : '0%' }} /></div><b>{count}</b><small>{stats.sample ? (count / stats.sample * 100).toFixed(1) : '0.0'}%</small></div>)}</div>
      </section>
      <section className="panel">
        <div className="section-heading">RECENT TICKS</div>
        <div className="table-wrap"><table><thead><tr><th>Time (UTC)</th><th>Quote</th><th>Last digit</th></tr></thead><tbody>
          {ticks.slice(-25).reverse().map((tick) => <tr key={tick.id}><td>{new Date(tick.epoch * 1000).toLocaleTimeString()}</td><td>{tick.quote}</td><td>{digitFromQuote(tick.quote, pipSize)}</td></tr>)}
          {!ticks.length && <tr><td colSpan={3} className="empty">Waiting for tick data…</td></tr>}
        </tbody></table></div>
      </section>
      <section className="panel">
        <div className="panel-title journal-toolbar"><div><div className="section-heading">FOUR-ENGINE RESEARCH JOURNAL · {marketName}</div><p className="muted">Only this selected market is shown. Decisions from other symbols are kept separate.</p></div><label className="journal-market-filter">Market<select value={symbol} disabled={demoAutoTrading || Boolean(openDemoContractRef.current)} onChange={(event) => selectSymbol(event.target.value)}>{symbols.map((item) => <option key={item.underlying_symbol} value={item.underlying_symbol}>{item.underlying_symbol_name || item.underlying_symbol}</option>)}</select></label></div>
        <p className="muted">Each decision is saved before its next-tick result is known, then updated when the next tick arrives. Unresolved decisions remain pending if the feed disconnects.</p>
        <div className="table-wrap"><table><thead><tr><th>Predicted (UTC)</th><th>Market</th><th>Engine</th><th>Target</th><th>Next digit</th><th>Prior-window frequency (not win probability)</th><th>Result</th></tr></thead><tbody>
          {marketResearchDecisions.slice(-100).reverse().map(item => <tr key={item.id}><td>{formatUtc(item.predictedEpoch)}</td><td>{item.symbol}</td><td>{item.strategy}</td><td>{item.strategy === 'EVEN' ? 'Even' : item.strategy === 'ODD' ? 'Odd' : item.targetDigit}</td><td>{item.outcomeDigit ?? 'Pending'}</td><td>{(item.empiricalRate*100).toFixed(1)}%</td><td className={item.correct === null ? '' : item.correct ? 'result-win' : 'result-loss'}>{item.correct === null ? 'Pending' : item.correct ? 'Win' : 'Loss'}</td></tr>)}
          {!marketResearchDecisions.length && <tr><td colSpan={7} className="empty">No journal entries for this market yet. Start one of the four research engines on this market after a full analysis window has loaded.</td></tr>}
        </tbody></table></div>
      </section>
      <section className="panel">
        <div className="section-heading">RECENT MODEL CHOICES</div>
        <p className="muted">These are recorded one-tick paper choices, not purchases.</p>
        <div className="table-wrap"><table><thead><tr><th>Time (UTC)</th><th>Barrier</th><th>Next digit</th><th>Result</th></tr></thead><tbody>
          {symbolOutcomes.slice(-12).reverse().map((item) => <tr key={item.id}><td>{new Date(item.settledEpoch * 1000).toLocaleTimeString()}</td><td>{item.barrier}</td><td>{item.outcomeDigit}</td><td className={item.correct ? 'result-win' : 'result-loss'}>{item.correct ? 'Correct' : 'Incorrect'}</td></tr>)}
          {!symbolOutcomes.length && <tr><td colSpan={4} className="empty">No settled choices yet. Collect at least one full analysis window, then wait for the next tick.</td></tr>}
        </tbody></table></div>
      </section>
    </>}

    {tab === 'settings' && <>
      <section className="panel settings-panel">
        <div className="panel-title"><div><div className="section-heading">TRADING RISK</div><p className="muted">Settings are stored in Neon through the private backend.</p></div><span className="saved-state">{saved ? 'Saved to Neon' : validSettings ? (backendStatus === 'Settings save failed' ? 'Save failed' : 'Saving…') : 'Check values'}</span></div>
        <label className="setting-field">Stake per trade (account currency)
          <div className="input-wrap"><span>units</span><input type="number" min="0.01" max="1000" step="0.01" value={settings.stake} onChange={(event) => changeSetting('stake', Number(event.target.value))} /></div>
          <small>Applied as the proposed contract stake when execution is enabled. Deriv minimums and account currency will still be checked by the backend.</small>
        </label>
        <label className="setting-field">Maximum daily loss (account currency)
          <div className="input-wrap"><span>units</span><input type="number" min="0.01" max="10000" step="0.01" value={settings.dailyLossLimit} onChange={(event) => changeSetting('dailyLossLimit', Number(event.target.value))} /></div>
          <small>Hard stop: the execution service must block new purchases once the realised daily net loss reaches this amount.</small>
        </label>
        <label className="setting-field">Take profit target (account currency)
          <div className="input-wrap"><span>units</span><input type="number" min="0.01" max="10000" step="0.01" value={settings.takeProfitLimit} onChange={(event) => changeSetting('takeProfitLimit', Number(event.target.value))} /></div>
          <small>Stored risk preference only. It is not an active trading stop while execution is locked.</small>
        </label>
        <label className="setting-field">Analysis window (ticks)
          <div className="input-wrap"><input type="number" min="50" max="5000" step="50" value={settings.windowSize} onChange={(event) => changeSetting('windowSize', Number(event.target.value))} /></div>
          <small>Changes the displayed rolling statistics. It does not by itself improve predictive accuracy.</small>
        </label>
        {!validSettings && <div className="validation-error">Use stake 0–1,000, daily loss 0–10,000, and an integer window of 50–5,000 ticks.</div>}
        <div className="settings-actions"><button className="secondary-button" onClick={() => setSettings(DEFAULT_SETTINGS)}>Restore defaults</button><span className="default-note">Defaults: 1.00 stake · 2.00 daily loss</span></div>
      </section>
      <section className="panel safety-panel">
        <div className="section-heading">DERIV DEMO ACCOUNT CONNECTION</div>
        <div className="candidate-row"><span>Public market data</span><strong>{status}</strong></div>
        <div className="candidate-row"><span>Deriv authorization</span><strong>{derivDemoConnected ? 'CONNECTED' : 'NOT CONNECTED'}</strong></div>
        <div className="candidate-row"><span>Demo session</span><strong>{derivDemoMessage}</strong></div>
        <p className="muted">Connect through Deriv OAuth. Lotus requests the trade scope only, stores the access token encrypted on the server, and exposes only verified demo accounts. No API token is pasted into the browser. The real-account WebSocket endpoint is explicitly rejected.</p>
        {!derivDemoConnected ? <button className="secondary-button" disabled={derivDemoBusy} onClick={beginDerivOAuth}>{derivDemoBusy ? 'CONNECTING…' : 'CONNECT DERIV DEMO ACCOUNT'}</button> : <>
          <label className="setting-field">Select a verified demo account
            <select value={selectedDemoAccountId} disabled={demoSocketStatus === 'CONNECTED' || demoSocketStatus === 'CONNECTING' || Boolean(openDemoContractRef.current)} onChange={event => setSelectedDemoAccountId(event.target.value)}>
              <option value="">Select demo account</option>
              {derivDemoAccounts.map(account => <option key={account.account_id} value={account.account_id}>{account.account_id} · {account.currency || 'Currency unavailable'}{account.balance === null ? '' : ' · ' + account.balance}</option>)}
            </select>
          </label>
          <div className="settings-actions">
            <button className="secondary-button" disabled={derivDemoBusy || !selectedDemoAccountId || demoSocketStatus === 'CONNECTED' || demoSocketStatus === 'CONNECTING'} onClick={openDerivDemoSession}>OPEN DEMO WEBSOCKET</button>
            <button className="secondary-button" disabled={derivDemoBusy} onClick={disconnectDerivDemo}>DISCONNECT</button>
          </div>
        </>}
        <p className="muted">Demo execution is available from the Differs / Matches Engine page after the authenticated demo WebSocket is connected. Lotus submits one-tick contracts only to the verified demo account. The real-account endpoint remains disabled and is never requested by this feature.</p>
      </section>
      <section className="panel safety-panel">
        <div className="section-heading">EXECUTION SAFETY</div>
        <ul>
          <li>Live trading remains disabled. The scanner only requests proposal prices and records paper outcomes.</li>
          <li>Profitability estimates use live ask/payout quotes and a 95% Wilson lower confidence bound on the observed paper win rate.</li>
          <li>Stake, daily loss limit and analysis window are saved through the authenticated backend in Neon.</li>
          <li>The server-side daily loss stop is not yet connected to real contract settlements. Account currency has not been verified. Live execution remains disabled.</li>
        </ul>
      </section>
    </>}

    <footer>LOTUS ENGINE · {status === 'CONNECTED' ? 'LIVE MARKET DATA' : 'HISTORICAL MODE'} · EXECUTION LOCKED · {backendStatus}</footer>
  </main>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="panel metric-card"><span>{label}</span><strong>{value}</strong></div>;
}

createRoot(document.getElementById('root')!).render(<App />);
