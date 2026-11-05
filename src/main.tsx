import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const WS = 'wss://ws.derivws.com/websockets/v3?app_id=1089';
type Tick = { id: string; symbol: string; quote: number; epoch: number; source: 'history' | 'live'; pipSize?: number; lastDigit?: number };
type ActiveSymbol = { underlying_symbol: string; underlying_symbol_name?: string; pip_size?: number };
type Settings = { stake: number; dailyLossLimit: number; windowSize: number };
type ChoiceOutcome = { id: string; symbol: string; barrier: number; predictedEpoch: number; settledEpoch: number; outcomeDigit: number; correct: boolean; analysisWindow?: number };
type Tab = 'overview' | 'activity' | 'settings';
const DEFAULT_SETTINGS: Settings = { stake: 1, dailyLossLimit: 2, windowSize: 100 };

function readSettings(): Settings {
  try {
    const saved = localStorage.getItem('ddpe-settings-v1');
    if (!saved) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(saved) as Partial<Settings>;
    return {
      stake: Number.isFinite(parsed.stake) && Number(parsed.stake) > 0 ? Number(parsed.stake) : 1,
      dailyLossLimit: Number.isFinite(parsed.dailyLossLimit) && Number(parsed.dailyLossLimit) > 0 ? Number(parsed.dailyLossLimit) : 2,
      windowSize: Number.isFinite(parsed.windowSize) && Number(parsed.windowSize) >= 50 ? Math.min(5000, Math.round(Number(parsed.windowSize))) : 100
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

function App() {
  const [tab, setTab] = useState<Tab>('overview');
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
  const [choiceOutcomes, setChoiceOutcomes] = useState<ChoiceOutcome[]>(() => {
    try { return JSON.parse(localStorage.getItem('ddpe-choice-outcomes-v1') || '[]') as ChoiceOutcome[]; }
    catch { return []; }
  });
  const ticksRef = useRef<Tick[]>([]);
  const pendingChoicesRef = useRef<Map<string, { id: string; symbol: string; barrier: number; predictedEpoch: number; analysisWindow: number }>>(new Map());
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
    const connect = () => {
      if (!alive) return;
      setStatus('CONNECTING');
      socket = new WebSocket(WS);
      ws.current = socket;
      socket.onopen = () => {
        if (!alive || !socket) return;
        setStatus('CONNECTED');
        setError('');
        // Ask Deriv only for underlyings that list DIGITDIFF as an available contract.
        // The current API no longer accepts product_type on active_symbols.
        socket.send(JSON.stringify({ active_symbols: 'brief', contract_type: ['DIGITDIFF'], req_id: 1 }));
      };
      socket.onmessage = (event) => {
        if (!alive) return;
        try {
          const response = JSON.parse(event.data);
          if (response.error) { setError(response.error.message || 'Deriv API error'); return; }
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
      socket.onerror = () => { if (alive) setError('Deriv WebSocket connection error.'); };
      socket.onclose = () => {
        if (!alive) return;
        subscriptionTimers.forEach((timer) => window.clearTimeout(timer));
        subscriptionTimers.length = 0;
        setStatus('RECONNECTING');
        reconnectTimer.current = window.setTimeout(connect, 2500);
      };
    };
    connect();
    return () => {
      alive = false;
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
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
      setSettings({ stake: Number(remote.stake), dailyLossLimit: Number(remote.dailyLossLimit), windowSize: Number(remote.windowSize) });
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
    let active = true;
    fetch(`/api/choices?symbol=${encodeURIComponent(symbol)}`, { credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load paper choices from Neon.');
        return response.json();
      })
      .then((data) => {
        if (!active || !Array.isArray(data.choices)) return;
        setChoiceOutcomes([...data.choices].sort((a, b) => a.settledEpoch - b.settledEpoch));
        try { localStorage.setItem('ddpe-choice-outcomes-v1', JSON.stringify(data.choices)); } catch {}
      })
      .catch(() => { if (active) setBackendStatus('Prediction history unavailable'); });
    return () => { active = false; };
  }, [authenticated, symbol]);

  useEffect(() => {
    if (!authenticated || !settingsLoaded) return;
    if (!(settings.stake > 0 && settings.stake <= 1000 && settings.dailyLossLimit > 0 && settings.dailyLossLimit <= 10000 && Number.isInteger(settings.windowSize) && settings.windowSize >= 50 && settings.windowSize <= 5000)) {
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
  const differsEstimate = stats.sample ? (1 - stats.barrierRate) * 100 : 0;
  const symbolOutcomes = choiceOutcomes.filter((item) => item.symbol === symbol);
  const settledCorrect = symbolOutcomes.filter((item) => item.correct).length;
  const settledAccuracy = symbolOutcomes.length ? settledCorrect / symbolOutcomes.length * 100 : null;
  const changeSetting = (key: keyof Settings, value: number) => {
    setSettings((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };
  const validSettings = settings.stake > 0 && settings.stake <= 1000 && settings.dailyLossLimit > 0 && settings.dailyLossLimit <= 10000 && Number.isInteger(settings.windowSize) && settings.windowSize >= 50 && settings.windowSize <= 5000;

  const selectSymbol = (nextSymbol: string) => {
    if (nextSymbol === selectedSymbolRef.current) return;
    selectedSymbolRef.current = nextSymbol;
    setSymbol(nextSymbol);
    const nextTicks = ticksBySymbolRef.current.get(nextSymbol) || [];
    ticksRef.current = nextTicks;
    setTicks(nextTicks);
    setPipSize(pipSizesBySymbolRef.current.get(nextSymbol));
  };

  const submitLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoginError('');
    try {
      const response = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: loginPassword }) });
      if (!response.ok) throw new Error(response.status === 401 ? 'Incorrect app password.' : 'Login service is not ready. Check backend configuration.');
      const savedResponse = await fetch('/api/settings', { credentials: 'same-origin', cache: 'no-store' });
      if (!savedResponse.ok) throw new Error('Login succeeded, but settings could not be loaded from Neon.');
      const remote = await savedResponse.json();
      setSettings({ stake: Number(remote.stake), dailyLossLimit: Number(remote.dailyLossLimit), windowSize: Number(remote.windowSize) });
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

  if (authChecking) return <main className="login-shell"><section className="panel login-panel"><div className="eyebrow">DDPE PRIVATE ACCESS</div><h1>Checking secure session</h1><p className="muted">{backendStatus}</p></section></main>;
  if (!authenticated) return <main className="login-shell"><form className="panel login-panel" onSubmit={submitLogin}><div className="eyebrow">DDPE PRIVATE ACCESS</div><h1>Sign in</h1><p className="muted">Use the private app password configured in your deployment's environment variables. This is not your Deriv API token.</p><label className="setting-field">App password<input type="password" autoComplete="current-password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} required /></label>{loginError && <div className="error" role="alert">{loginError}</div>}<button className="secondary-button" type="submit">Sign in</button><small className="muted">Backend: {backendStatus}</small></form></main>;

  return <main>
    <header className="topbar">
      <div><div className="eyebrow">DDPE · DERIV DIFFERS</div><h1>Digit Prediction Engine</h1><p className="subhead">Live market research and risk controls</p></div>
      <div className="header-actions"><span className={status === 'CONNECTED' ? 'status online' : 'status'}><i />{status}</span><button className="secondary-button" onClick={logout}>Sign out</button></div>
    </header>

    <nav className="tabs" aria-label="Main navigation">
      <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button>
      <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>Activity</button>
      <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Settings</button>
    </nav>

    {error && <div className="error" role="alert">{error}</div>}

    {tab === 'overview' && <>
      <section className="panel market-panel">
        <label className="field">Market
          <select value={symbol} onChange={(event) => selectSymbol(event.target.value)}>
            {symbols.map((item) => <option key={item.underlying_symbol} value={item.underlying_symbol}>{item.underlying_symbol_name || item.underlying_symbol}</option>)}
          </select>
        </label>
        <div className="quote"><span>{marketName}</span><strong>{ticks.at(-1)?.quote ?? '—'}</strong><small>{ticks.length.toLocaleString()} ticks in this market · {symbols.length} Differs-capable markets monitored</small></div>
      </section>

      <section className="overview-grid">
        <div className="panel decision-panel">
          <div className="section-heading">DIFFERS RESEARCH STATUS</div>
          <div className="decision">COLLECTING DATA</div>
          <p className="muted">No live order is being sent. The current repository has no authenticated execution service or validated signal model.</p>
          <div className="divider" />
          <div className="candidate-row"><span>Least frequent digit candidate</span><strong>{stats.barrier >= 0 ? stats.barrier : '—'}</strong></div>
          <div className="candidate-row"><span>Observed Differs rate vs candidate</span><strong>{stats.sample ? differsEstimate.toFixed(2) + '%' : '—'}</strong></div>
          <div className="candidate-row"><span>Reference baseline</span><strong>90.00%</strong></div>
        </div>
        <div className="panel risk-panel">
          <div className="section-heading">RISK SETTINGS</div>
          <div className="risk-value"><span>Stake per trade</span><strong>{settings.stake.toFixed(2)} units</strong></div>
          <div className="risk-value"><span>Daily loss stop</span><strong>{settings.dailyLossLimit.toFixed(2)} units</strong></div>
          <div className="risk-value"><span>Loss limit usage</span><strong>Not connected</strong></div>
          <button className="secondary-button" onClick={() => setTab('settings')}>Adjust settings</button>
        </div>
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
        <div><div className="section-heading">BOT CONTROL</div><p className="muted">Execution is locked until the authenticated backend, persistent risk ledger and payout validation are implemented.</p></div>
        <div className="control-row"><button className="start-button" disabled title="Execution backend is not connected">START BOT</button><button className="stop-button" disabled title="No execution worker is connected">STOP BOT</button></div>
        <small className="lock-note">Research feed is active. Live trading is not enabled.</small>
      </section>
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
        <label className="setting-field">Analysis window (ticks)
          <div className="input-wrap"><input type="number" min="50" max="5000" step="50" value={settings.windowSize} onChange={(event) => changeSetting('windowSize', Number(event.target.value))} /></div>
          <small>Changes the displayed rolling statistics. It does not by itself improve predictive accuracy.</small>
        </label>
        {!validSettings && <div className="validation-error">Use stake 0–1,000, daily loss 0–10,000, and an integer window of 50–5,000 ticks.</div>}
        <div className="settings-actions"><button className="secondary-button" onClick={() => setSettings(DEFAULT_SETTINGS)}>Restore defaults</button><span className="default-note">Defaults: 1.00 stake · 2.00 daily loss</span></div>
      </section>
      <section className="panel safety-panel">
        <div className="section-heading">EXECUTION SAFETY</div>
        <ul>
          <li>Live trading remains disabled in this build.</li>
          <li>Stake, daily loss limit and analysis window are saved through the authenticated backend in Neon.</li>
          <li>The server-side daily loss stop is not yet connected to real contract settlements. Account currency has not been verified. Live execution remains disabled.</li>
        </ul>
      </section>
    </>}

    <footer>DDPE private research interface · {backendStatus} · no order execution in this build</footer>
  </main>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="panel metric-card"><span>{label}</span><strong>{value}</strong></div>;
}

createRoot(document.getElementById('root')!).render(<App />);
