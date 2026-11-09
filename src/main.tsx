import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

// Public, read-only market-data endpoint for the current Deriv API.
// No App ID or account token is required for public symbols, ticks, history, or proposals.
const DERIV_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
type Tick = { id: string; symbol: string; quote: number; epoch: number; source: 'history' | 'live'; pipSize?: number; lastDigit?: number };
type ActiveSymbol = { underlying_symbol: string; underlying_symbol_name?: string; pip_size?: number };
type Settings = { stake: number; dailyLossLimit: number; takeProfitLimit: number; windowSize: number; currency: string };
type ProposalQuote = { barrier: number; askPrice: number; payout: number; quotedAt: number };
type ChoiceAggregate = { symbol: string; barrier: number; total: number; wins: number };
type ChoiceOutcome = { id: string; symbol: string; barrier: number; predictedEpoch: number; settledEpoch: number; outcomeDigit: number; correct: boolean; analysisWindow?: number };
type ResearchStrategy = 'DIFFERS' | 'MATCHES' | 'EVEN' | 'ODD';
type ResearchDecision = { id: string; symbol: string; strategy: ResearchStrategy; targetDigit: number; predictedEpoch: number; settledEpoch: number | null; outcomeDigit: number | null; correct: boolean | null; analysisWindow: number; sampleSize: number; empiricalRate: number; modelVersion: string };
type PendingResearch = { decision_uid: string; symbol: string; strategy: ResearchStrategy; target_digit: number; predicted_at_epoch: number; analysis_window: number; sample_size: number; empirical_rate: number; model_version: string };
type Tab = 'overview' | 'engine' | 'wins' | 'activity' | 'settings';
const DEFAULT_SETTINGS: Settings = { stake: 1, dailyLossLimit: 2, takeProfitLimit: 5, windowSize: 100, currency: '' };

function readSettings(): Settings {
  try {
    const saved = localStorage.getItem('ddpe-settings-v1');
    if (!saved) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(saved) as Partial<Settings>;
    return {
      stake: Number.isFinite(parsed.stake) && Number(parsed.stake) > 0 ? Number(parsed.stake) : 1,
      dailyLossLimit: Number.isFinite(parsed.dailyLossLimit) && Number(parsed.dailyLossLimit) > 0 ? Number(parsed.dailyLossLimit) : 2,
      takeProfitLimit: Number.isFinite(parsed.takeProfitLimit) && Number(parsed.takeProfitLimit) > 0 ? Number(parsed.takeProfitLimit) : 5,
      windowSize: Number.isFinite(parsed.windowSize) && Number(parsed.windowSize) >= 50 ? Math.min(5000, Math.round(Number(parsed.windowSize))) : 100,
      currency: typeof parsed.currency === 'string' ? parsed.currency.trim().toUpperCase() : ''
    };
  } catch { return DEFAULT_SETTINGS; }
}

function digitFromQuote(quote: number, pipSize?: number): number {
  if (!Number.isFinite(quote)) return 0;
  // Deriv pip_size is the number of decimal places, not a fractional price increment.
  const decimals = Number.isInteger(pipSize) && Number(pipSize) >= 0 && Number(pipSize) <= 10
    ? Number(pipSize)
    : ((String(quote).split('.')[1] || '').length);
  const fixed = quote.toFixed(decimals);
  return Number((fixed.split('.')[1] || fixed).slice(-1) || 0);
}

function getStats(digits: number[]) {
  const counts = Array<number>(10).fill(0);
  digits.forEach((digit) => { if (Number.isInteger(digit) && digit >= 0 && digit <= 9) counts[digit] += 1; });
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

function wilsonLowerBound(wins: number, total: number, z = 1.96): number {
  if (!total) return 0;
  const p = wins / total;
  const z2 = z * z;
  return (p + z2 / (2 * total) - z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / (1 + z2 / total);
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
  const [choiceOutcomes, setChoiceOutcomes] = useState<ChoiceOutcome[]>(() => {
    try { return JSON.parse(localStorage.getItem('ddpe-choice-outcomes-v1') || '[]') as ChoiceOutcome[]; }
    catch { return []; }
  });
  const ticksRef = useRef<Tick[]>([]);
  useEffect(() => { analysisStateRef.current = { running: analysisRunning, strategy: activeStrategy }; }, [analysisRunning, activeStrategy]);
  useEffect(() => { try { localStorage.setItem('lotus-theme', theme); } catch {} document.body.dataset.theme = theme; }, [theme]);
  const pendingChoicesRef = useRef<Map<string, { id: string; symbol: string; barrier: number; predictedEpoch: number; analysisWindow: number }>>(new Map());
  const pendingResearchRef = useRef<Map<string, PendingResearch>>(new Map());
  const analysisStateRef = useRef<{ running: boolean; strategy: ResearchStrategy }>({ running: false, strategy: 'DIFFERS' });
  const ticksBySymbolRef = useRef<Map<string, Tick[]>>(new Map());
  const pipSizesBySymbolRef = useRef<Map<string, number>>(new Map());
  const selectedSymbolRef = useRef(symbol);
  selectedSymbolRef.current = symbol;
  const windowSizeRef = useRef(settings.windowSize);
  windowSizeRef.current = settings.windowSize;
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | undefined>();
  const pendingTicksRef = useRef<Array<{ tick_uid: string; symbol: string; epoch: number; quote: number; pip_size: number; last_digit: number }>>([]);
  const persistInFlightRef = useRef(false);
  const proposalRequestsRef = useRef(new Map<number, { symbol: string; barrier: number; currency: string; stake: number }>());
  const proposalReqIdRef = useRef(3000);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

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
        socket.send(JSON.stringify({ active_symbols: 'brief', contract_type: ['DIGITDIFF', 'DIGITMATCH', 'DIGITEVEN', 'DIGITODD'], req_id: 1 }));
      };
      socket.onmessage = (event) => {
        if (!alive) return;
        try {
          const response = JSON.parse(event.data);
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
            return;
          }
          if (response.msg_type === 'proposal' && response.proposal) {
            const reqId = Number(response.req_id);
            const request = proposalRequestsRef.current.get(reqId);
            if (request && request.currency === settingsRef.current.currency && request.stake === settingsRef.current.stake) {
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
            const list: ActiveSymbol[] = response.active_symbols || [];
            setSymbols(list);
            list.forEach((item, index) => {
              const marketSymbol = item.underlying_symbol;
              if (!marketSymbol) return;
              if (Number.isInteger(item.pip_size) && Number(item.pip_size) >= 0 && Number(item.pip_size) <= 10) {
                pipSizesBySymbolRef.current.set(marketSymbol, Number(item.pip_size));
              }
              // Seed every DIGITDIFF-capable market and subscribe to each live stream.
              const delay = index * 75;
              subscriptionTimers.push(window.setTimeout(() => {
                if (alive && socket?.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({ ticks_history: marketSymbol, count: 1000, end: 'latest', style: 'ticks', req_id: 1000 + index }));
                }
              }, delay));
              subscriptionTimers.push(window.setTimeout(() => {
                if (alive && socket?.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({ ticks: marketSymbol, subscribe: 1, req_id: 2000 + index }));
                }
              }, delay + 25));
            });
            const selected = selectedSymbolRef.current;
            if (list.length && !list.some((item) => item.underlying_symbol === selected)) {
              const first = list[0].underlying_symbol;
              if (first) selectSymbol(first);
            } else {
              setPipSize(pipSizesBySymbolRef.current.get(selected));
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
            const responsePrecision = Number(response.pip_size);
            if (Number.isInteger(responsePrecision) && responsePrecision >= 0 && responsePrecision <= 10) {
              pipSizesBySymbolRef.current.set(historySymbol, responsePrecision);
            }
            const precision = pipSizesBySymbolRef.current.get(historySymbol);
            const merged = new Map<string, Tick>();
            [...history, ...(ticksBySymbolRef.current.get(historySymbol) || [])].forEach((tick) => merged.set(tick.id, tick));
            let nextTicks = [...merged.values()].sort((a, b) => a.epoch - b.epoch).slice(-5000);
            if (precision !== undefined) {
              nextTicks = nextTicks.map((tick) => tick.source === 'live' && tick.pipSize === undefined
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
            const responsePrecision = response.tick.pip_size !== undefined ? Number(response.tick.pip_size) : undefined;
            if (responsePrecision !== undefined && Number.isInteger(responsePrecision) && responsePrecision >= 0 && responsePrecision <= 10) {
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
              if (!currentTicks.some((item) => item.id === tick.id)) {
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
                  if (priorDigits.length >= windowSizeRef.current && analysisStateRef.current.running) {
                    const priorStats = getStats(priorDigits);
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
                  if (priorDigits.length >= windowSizeRef.current) {
                    const priorStats = getStats(priorDigits);
                    if (priorStats.barrier >= 0) {
                      pendingChoicesRef.current.set(marketSymbol, {
                        id: crypto.randomUUID(),
                        symbol: marketSymbol,
                        barrier: priorStats.barrier,
                        predictedEpoch: epoch,
                        analysisWindow: windowSizeRef.current,
                      });
                    }
                  }
                }
                const nextTicks = [...currentTicks, tick].sort((a, b) => a.epoch - b.epoch).slice(-5000);
                ticksBySymbolRef.current.set(marketSymbol, nextTicks);
                if (marketSymbol === selectedSymbolRef.current) {
                  ticksRef.current = nextTicks;
                  setTicks(nextTicks);
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
      setSettings({ stake: Number(remote.stake), dailyLossLimit: Number(remote.dailyLossLimit), takeProfitLimit: Number(remote.takeProfitLimit), windowSize: Number(remote.windowSize), currency: String(remote.currency || '') });
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
    const conservativeEv = quote && matchedSample >= 100 && conservativeWinRate !== null ? conservativeWinRate * quote.payout - quote.askPrice : null;
    return { symbol: item.underlying_symbol, name: item.underlying_symbol_name || item.underlying_symbol, total, wins, winRate, matchedSample, matchedWinRate, conservativeWinRate, quote, conservativeEv };
  }).sort((a, b) => (b.conservativeEv ?? -Infinity) - (a.conservativeEv ?? -Infinity)), [symbols, choiceAggregates, proposalQuotes]);
  const qualifiedMarkets = scannerRows.filter((row) => row.matchedSample >= 100 && row.quote && row.conservativeEv !== null && row.conservativeEv > 0);
  const bestMarket = qualifiedMarkets[0] || null;
  const highestWinRateMarket = scannerRows.filter((row) => row.total >= 100 && row.winRate !== null).sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1))[0] || null;
  const differsEstimate = stats.sample ? (1 - stats.barrierRate) * 100 : 0;
  const symbolOutcomes = choiceOutcomes.filter((item) => item.symbol === symbol);
  const settledCorrect = symbolOutcomes.filter((item) => item.correct).length;
  const settledAccuracy = symbolOutcomes.length ? settledCorrect / symbolOutcomes.length * 100 : null;
  const changeSetting = (key: keyof Settings, value: number | string) => {
    setSettings((current) => ({ ...current, [key]: value } as Settings));
    setSaved(false);
  };
  const validSettings = settings.stake > 0 && settings.stake <= 1000 && settings.dailyLossLimit > 0 && settings.dailyLossLimit <= 10000 && settings.takeProfitLimit > 0 && settings.takeProfitLimit <= 10000 && Number.isInteger(settings.windowSize) && settings.windowSize >= 50 && settings.windowSize <= 5000;

  function requestMarketProposal(marketSymbol: string, marketTicks?: Tick[]) {
    const currentSettings = settingsRef.current;
    const socket = ws.current;
    if (!currentSettings.currency || !socket || socket.readyState !== WebSocket.OPEN) return;
    const sourceTicks = marketTicks || ticksBySymbolRef.current.get(marketSymbol) || [];
    const digits = sourceTicks.slice(-currentSettings.windowSize).map((tick) => tick.lastDigit ?? digitFromQuote(tick.quote, tick.pipSize));
    if (digits.length < currentSettings.windowSize) return;
    const barrier = getStats(digits).barrier;
    if (barrier < 0) return;
    for (const [pendingId, pending] of proposalRequestsRef.current) {
      if (pending.symbol === marketSymbol) proposalRequestsRef.current.delete(pendingId);
    }
    const reqId = proposalReqIdRef.current++;
    proposalRequestsRef.current.set(reqId, { symbol: marketSymbol, barrier, currency: currentSettings.currency, stake: currentSettings.stake });
    socket.send(JSON.stringify({ proposal: 1, amount: currentSettings.stake, basis: 'stake', contract_type: 'DIGITDIFF', currency: currentSettings.currency, duration: 1, duration_unit: 't', underlying_symbol: marketSymbol, barrier: String(barrier), req_id: reqId }));
  }

  const selectSymbol = (nextSymbol: string) => {
    if (nextSymbol === selectedSymbolRef.current) return;
    selectedSymbolRef.current = nextSymbol;
    setSymbol(nextSymbol);
    const nextTicks = ticksBySymbolRef.current.get(nextSymbol) || [];
    ticksRef.current = nextTicks;
    setTicks(nextTicks);
    setPipSize(pipSizesBySymbolRef.current.get(nextSymbol));
  };

  useEffect(() => {
    if (!authenticated || !settings.currency) { proposalRequestsRef.current.clear(); setProposalQuotes({}); return; }
    proposalRequestsRef.current.clear();
    setProposalQuotes({});
    let quoteTimers: number[] = [];
    const scheduleQuotes = () => {
      quoteTimers.forEach((timerId) => window.clearTimeout(timerId));
      quoteTimers = symbols.map((item, index) => window.setTimeout(() => requestMarketProposal(item.underlying_symbol), index * 75));
    };
    scheduleQuotes();
    const timer = window.setInterval(() => {
      setProposalQuotes((previous) => Object.fromEntries(Object.entries(previous).filter(([, quote]) => Date.now() - quote.quotedAt <= 90000)));
      scheduleQuotes();
    }, 60000);
    return () => { window.clearInterval(timer); quoteTimers.forEach((timerId) => window.clearTimeout(timerId)); };
  }, [authenticated, symbols, settings.currency, settings.stake, settings.windowSize]);

  const submitLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoginError('');
    try {
      const response = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: loginPassword }) });
      if (!response.ok) throw new Error(response.status === 401 ? 'Incorrect app password.' : 'Login service is not ready. Check backend configuration.');
      const savedResponse = await fetch('/api/settings', { credentials: 'same-origin', cache: 'no-store' });
      if (!savedResponse.ok) throw new Error('Login succeeded, but settings could not be loaded from Neon.');
      const remote = await savedResponse.json();
      setSettings({ stake: Number(remote.stake), dailyLossLimit: Number(remote.dailyLossLimit), takeProfitLimit: Number(remote.takeProfitLimit), windowSize: Number(remote.windowSize), currency: String(remote.currency || '') });
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
      <div><div className="eyebrow">LOTUS · DERIV RESEARCH</div><h1>Lotus</h1><p className="subhead">Deriv digit intelligence · research first</p></div>
      <div className="header-actions"><span className={status === 'CONNECTED' ? 'status online' : 'status'}><i />MARKET {status}</span><span className="status account-status">ACCOUNT NOT LINKED</span><button className="secondary-button theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</button><button className="secondary-button" onClick={logout}>Sign out</button></div>
    </header>

    <nav className="tabs" aria-label="Main navigation">
      <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button>
      <button className={tab === 'engine' ? 'active' : ''} onClick={() => setTab('engine')}>Differs / Matches</button>
      <button className={tab === 'wins' ? 'active' : ''} onClick={() => setTab('wins')}>Wins</button>
      <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>Journal</button>
      <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Settings</button>
    </nav>

    <section className="mode-banner">
      <span className={status === 'CONNECTED' ? 'mode-light active' : 'mode-light'} />
      <div><strong>LOTUS ENGINE</strong><small>{status === 'CONNECTED' ? 'LIVE MARKET FEED · RESEARCH MODE' : 'HISTORICAL MODE · LAST AVAILABLE DATA'}</small></div>
      <span className="execution-lock">EXECUTION LOCKED</span>
    </section>
    {error && <div className="error" role="alert">{error}</div>}

    {tab === 'overview' && <>
      <section className="panel market-panel">
        <label className="field">Market
          <select value={symbol} onChange={(event) => selectSymbol(event.target.value)}>
            {symbols.map((item) => <option key={item.underlying_symbol} value={item.underlying_symbol}>{item.underlying_symbol_name || item.underlying_symbol}</option>)}
          </select>
        </label>
        <div className="quote"><span>{marketName}</span><strong>{ticks.at(-1)?.quote ?? '—'}</strong><small>{ticks.length.toLocaleString()} ticks in this market · {symbols.length} digit-contract markets monitored</small></div>
      </section>

      <section className="overview-grid">
        <div className="panel decision-panel">
          <div className="section-heading">DIFFERS SIGNAL RESEARCH</div>
          <div className="decision">COLLECTING DATA</div>
          <p className="muted">No live order is being sent. The current repository has no authenticated execution service or validated signal model.</p>
          <div className="divider" />
          <div className="candidate-row"><span>Least frequent digit candidate</span><strong>{stats.barrier >= 0 ? stats.barrier : '—'}</strong></div>
          <div className="candidate-row"><span>Observed Differs rate vs candidate</span><strong>{stats.sample ? differsEstimate.toFixed(2) + '%' : '—'}</strong></div>
          <div className="candidate-row"><span>Reference baseline</span><strong>90.00%</strong></div>
          <div className="candidate-row"><span>Settled paper choices</span><strong>{symbolOutcomes.length}</strong></div>
        </div>
        <div className="panel risk-panel">
          <div className="section-heading">RISK SETTINGS</div>
          <div className="risk-value"><span>Stake per trade</span><strong>{settings.stake.toFixed(2)} units</strong></div>
          <div className="risk-value"><span>Daily loss limit</span><strong>{settings.dailyLossLimit.toFixed(2)} units</strong></div><div className="risk-value"><span>Take profit target</span><strong>{settings.takeProfitLimit.toFixed(2)} units</strong></div>
          <div className="risk-value"><span>Loss limit usage</span><strong>Not connected</strong></div>
          <button className="secondary-button" onClick={() => setTab('settings')}>Adjust settings</button>
        </div>
      </section>

      <section className="panel market-scanner">
        <div className="panel-title"><div><div className="section-heading">CROSS-MARKET RESEARCH SCANNER</div><p className="muted">All eligible markets · live one-tick DIGITDIFF quotes · settled paper outcomes.</p></div><span className="live-dot">{settings.currency ? 'SCANNING' : 'SET CURRENCY'}</span></div>
        {highestWinRateMarket && <div className="scanner-leader"><span>Highest observed win rate (100+ outcomes)</span><strong>{highestWinRateMarket.name}</strong><small>{(highestWinRateMarket.winRate! * 100).toFixed(2)}% observed win rate from {highestWinRateMarket.total} settled paper outcomes</small></div>}
        {bestMarket ? <div className="scanner-leader"><span>Best profitability-qualified candidate</span><strong>{bestMarket.name}</strong><small>{(bestMarket.winRate! * 100).toFixed(2)}% observed win rate · barrier {bestMarket.quote!.barrier} · {(bestMarket.conservativeWinRate! * 100).toFixed(2)}% 95% lower bound · +{bestMarket.conservativeEv!.toFixed(4)} {settings.currency} conservative EV per contract</small></div> : <p className="muted">No market has met every profitability gate yet: at least 100 settled paper outcomes for the exact quoted barrier, a fresh proposal quote in your account currency, and positive conservative expected value. The scanner will not call an under-sampled market profitable.</p>}
        <div className="table-wrap"><table><thead><tr><th>Market</th><th>Barrier</th><th>Settled / matched</th><th>Strategy win rate</th><th>Quoted-barrier win rate</th><th>95% lower bound</th><th>Ask / payout</th><th>Conservative EV</th><th>Gate</th></tr></thead><tbody>
          {scannerRows.map((row) => <tr key={row.symbol}><td><button className="text-button" onClick={() => selectSymbol(row.symbol)}>{row.name}</button></td><td>{row.quote ? row.quote.barrier : '—'}</td><td>{row.total} / {row.matchedSample}</td><td>{row.winRate === null ? '—' : (row.winRate * 100).toFixed(2) + '%'}</td><td>{row.matchedWinRate === null ? '—' : (row.matchedWinRate * 100).toFixed(2) + '%'}</td><td>{row.conservativeWinRate === null ? '—' : (row.conservativeWinRate * 100).toFixed(2) + '%'}</td><td>{row.quote ? `${row.quote.askPrice.toFixed(4)} / ${row.quote.payout.toFixed(4)}` : 'Waiting'}</td><td>{row.conservativeEv === null ? '—' : `${row.conservativeEv >= 0 ? '+' : ''}${row.conservativeEv.toFixed(4)} ${settings.currency}`}</td><td>{!row.quote ? 'Need live quote' : row.matchedSample < 100 ? 'Need 100 barrier matches' : row.conservativeEv! > 0 ? 'Positive estimate' : 'Not profitable'}</td></tr>)}
          {!scannerRows.length && <tr><td colSpan={9} className="empty">Waiting for eligible Differs markets…</td></tr>}
        </tbody></table></div>
        <small className="muted">Conservative EV = Wilson 95% lower-bound win probability for the currently quoted barrier × gross payout − ask price. Strategy-wide win rate is shown separately. Outcomes are paper predictions, not actual contract settlements; serial dependence and market-selection bias are not corrected. Positive estimates are not proof of future profitability.</small>
      </section>

      <section className="panel">
        <div className="panel-title"><div><div className="section-heading">LIVE DIGIT STREAM</div><p className="muted">Latest 60 final quote digits</p></div><span className="live-dot">LIVE FEED</span></div>
        <div className="digits">{digits.slice(-60).map((digit, index, array) => <span key={ticks.slice(-60)[index]?.id ?? index} className={index === array.length - 1 ? 'last' : ''}>{digit}</span>)}</div>
      </section>

      <section className="stats-grid">
        <Metric label={settings.windowSize + '-tick sample'} value={stats.sample.toString()} />
        <Metric label="Shannon entropy" value={stats.sample ? stats.entropy.toFixed(3) : '—'} />
        <Metric label="All-session ticks" value={digits.length.toLocaleString()} />
        <Metric label="Out-of-sample edge" value="Not tested" />
      </section>

      <section className="panel action-panel">
        <div><div className="section-heading">EXECUTION CONTROL</div><p className="muted">Research continues independently of execution. Live orders remain locked until account authorization, settlement reconciliation and server-enforced risk controls are validated.</p></div>
        <div className="control-row"><button className="start-button" disabled title="Execution backend is not connected">START ANALYSIS</button><button className="stop-button" disabled title="No execution worker is connected">STOP EXECUTION</button></div>
        <small className="lock-note">RESEARCH FEED ACTIVE · LIVE EXECUTION DISABLED</small>
      </section>
    </>}

    {tab === 'engine' && <>
      <section className="panel engine-hero">
        <div className="section-heading">LOTUS DIGIT INTELLIGENCE</div><h2>Choose a research engine</h2>
        <p className="muted">Both engines score the next observed tick. These are frequency baselines, not proven predictive edges.</p>
        <div className="strategy-switch">
          <button className={activeStrategy === 'DIFFERS' ? 'selected' : ''} onClick={() => { setActiveStrategy('DIFFERS'); setAnalysisRunning(false); }}>DIFFERS<small>Next digit is not the target</small></button>
          <button className={activeStrategy === 'MATCHES' ? 'selected' : ''} onClick={() => { setActiveStrategy('MATCHES'); setAnalysisRunning(false); }}>MATCHES<small>Next digit equals the target</small></button>
          <button className={activeStrategy === 'EVEN' ? 'selected' : ''} onClick={() => { setActiveStrategy('EVEN'); setAnalysisRunning(false); }}>EVEN<small>Next digit is even</small></button>
          <button className={activeStrategy === 'ODD' ? 'selected' : ''} onClick={() => { setActiveStrategy('ODD'); setAnalysisRunning(false); }}>ODD<small>Next digit is odd</small></button>
        </div>
        <div className="research-signal">
          <span className="section-heading">{activeStrategy} · {marketName}</span>
          <div className="signal-digit">{activeStrategy === 'DIFFERS' ? (stats.barrier >= 0 ? stats.barrier : '—') : activeStrategy === 'MATCHES' ? (stats.sample ? stats.counts.indexOf(Math.max(...stats.counts)) : '—') : activeStrategy}</div>
          <div className="signal-label">{activeStrategy === 'EVEN' || activeStrategy === 'ODD' ? 'PREDICTED PARITY' : 'TARGET DIGIT'}</div><div className="confidence-track"><i style={{ width: (stats.sample ? Math.min(100, (activeStrategy === 'DIFFERS' ? 1 - stats.barrierRate : activeStrategy === 'MATCHES' ? Math.max(...stats.probabilities) : rollingDigits.filter(digit => activeStrategy === 'EVEN' ? digit % 2 === 0 : digit % 2 === 1).length / stats.sample) * 100) : 0) + '%' }} /></div>
          <div className="candidate-row"><span>Observed baseline success rate</span><strong>{stats.sample ? ((activeStrategy === 'DIFFERS' ? 1 - stats.barrierRate : activeStrategy === 'MATCHES' ? Math.max(...stats.probabilities) : rollingDigits.filter(digit => activeStrategy === 'EVEN' ? digit % 2 === 0 : digit % 2 === 1).length / stats.sample) * 100).toFixed(2) + '%' : '—'}</strong></div>
          <div className="candidate-row"><span>Historical sample</span><strong>{stats.sample} / {settings.windowSize}</strong></div>
          <div className="candidate-row"><span>Model confidence</span><strong>Not calibrated</strong></div>
          <p className="muted">Differs selects the least frequent digit; Matches selects the most frequent. Even and Odd score the next digit against the selected parity. All four are descriptive research baselines, can overfit noise, and do not establish a predictive edge.</p>
        </div>
        <div className="control-row research-controls">
          <button className="start-button" onClick={() => setAnalysisRunning(true)} disabled={analysisRunning || stats.sample < settings.windowSize}>START {activeStrategy} ANALYSIS</button>
          <button className="stop-button" onClick={() => setAnalysisRunning(false)} disabled={!analysisRunning}>STOP ANALYSIS</button>
        </div>
        <small className="lock-note">{analysisRunning ? activeStrategy + ' paper research running · no Deriv orders sent' : 'Research feed remains connected · start an engine to journal paper choices'}</small>
      </section>
      <section className="panel"><div className="section-heading">LIVE TRADING MASTER SWITCH</div><div className="master-row"><div><strong>Live execution</strong><p className="muted">Locked pending account authorization, verified settlement reconciliation and server-enforced risk controls.</p></div><div className="master-actions"><button className="master-switch" disabled aria-pressed={liveMaster}>OFF · LOCKED</button><button className="stop-button" onClick={() => setLiveMaster(false)}>STOP EXECUTION</button></div></div></section>
      <section className="panel"><div className="section-heading">CROSS-MARKET RESEARCH</div><p className="muted">Public market ticks are collected while this dashboard is open. Closing the browser stops the live collector in this version.</p><div className="candidate-row"><span>Markets subscribed</span><strong>{symbols.length}</strong></div><div className="candidate-row"><span>Live tick stream</span><strong>{status}</strong></div><div className="candidate-row"><span>Persisted research decisions</span><strong>{researchDecisions.length}</strong></div></section>
    </>}

    {tab === 'wins' && <>
      <section className="stats-grid wins-grid">{(['DIFFERS','MATCHES','EVEN','ODD'] as ResearchStrategy[]).map(strategy => { const rows = researchDecisions.filter(item => item.strategy === strategy && item.correct !== null); const wins = rows.filter(item => item.correct).length; return <div className="panel metric-card" key={strategy}><span>{strategy} PAPER WIN RATE</span><strong>{rows.length ? (wins / rows.length * 100).toFixed(2) + '%' : '—'}</strong><small>{wins} wins · {rows.length - wins} losses · {rows.length} settled</small></div>; })}</section>
      <section className="overview-grid"><div className="panel metric-card"><span>VERIFIED LIVE P/L</span><strong>—</strong><small>Unavailable: live trading is disabled.</small></div><div className="panel metric-card"><span>LIVE ACCOUNT WIN RATE</span><strong>—</strong><small>No live contracts have been executed or settled.</small></div></section>
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
        <div className="section-heading">FOUR-ENGINE RESEARCH JOURNAL</div>
        <p className="muted">Each decision is saved before its next-tick result is known, then updated when the next tick arrives. Unresolved decisions remain pending if the feed disconnects.</p>
        <div className="table-wrap"><table><thead><tr><th>Predicted (UTC)</th><th>Market</th><th>Engine</th><th>Target</th><th>Next digit</th><th>Empirical rate</th><th>Result</th></tr></thead><tbody>
          {researchDecisions.slice(-100).reverse().map(item => <tr key={item.id}><td>{new Date(item.predictedEpoch*1000).toLocaleString()}</td><td>{item.symbol}</td><td>{item.strategy}</td><td>{item.strategy === 'EVEN' ? 'Even' : item.strategy === 'ODD' ? 'Odd' : item.targetDigit}</td><td>{item.outcomeDigit ?? 'Pending'}</td><td>{(item.empiricalRate*100).toFixed(1)}%</td><td className={item.correct === null ? '' : item.correct ? 'result-win' : 'result-loss'}>{item.correct === null ? 'Pending' : item.correct ? 'Win' : 'Loss'}</td></tr>)}
          {!researchDecisions.length && <tr><td colSpan={7} className="empty">No research decisions yet. Start an engine after a full analysis window has loaded.</td></tr>}
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
        <label className="setting-field">Deriv account currency
          <input type="text" maxLength={20} autoCapitalize="characters" placeholder="e.g. USD, EUR, USDT" value={settings.currency} onChange={(event) => changeSetting('currency', event.target.value.trim().toUpperCase())} />
          <small>Enter the exact currency displayed in your Deriv account. Do not guess. This is required for comparable proposal prices.</small>
        </label>
        <label className="setting-field">Analysis window (ticks)
          <div className="input-wrap"><input type="number" min="50" max="5000" step="50" value={settings.windowSize} onChange={(event) => changeSetting('windowSize', Number(event.target.value))} /></div>
          <small>Changes the displayed rolling statistics. It does not by itself improve predictive accuracy.</small>
        </label>
        {!validSettings && <div className="validation-error">Use stake 0–1,000, daily loss 0–10,000, and an integer window of 50–5,000 ticks.</div>}
        <div className="settings-actions"><button className="secondary-button" onClick={() => setSettings(DEFAULT_SETTINGS)}>Restore defaults</button><span className="default-note">Defaults: 1.00 stake · 2.00 daily loss</span></div>
      </section>
      <section className="panel safety-panel">
        <div className="section-heading">DERIV ACCOUNT CONNECTION</div>
        <div className="candidate-row"><span>Public market data</span><strong>{status}</strong></div>
        <div className="candidate-row"><span>Trading account</span><strong>Not connected</strong></div>
        <p className="muted">Account authorization is not yet enabled. Do not paste an API token into this page. The account connection will use a secure authorization flow with explicitly scoped permissions, server-side safeguards and verified account identity.</p>
        <button className="secondary-button" disabled title="Secure Deriv authorization flow is not implemented yet">CONNECT DERIV ACCOUNT · LOCKED</button>
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
