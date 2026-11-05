import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const WS = 'wss://ws.derivws.com/websockets/v3?app_id=1089';
type Tick = { quote: number; epoch: number };
type ActiveSymbol = { underlying_symbol: string; underlying_symbol_name?: string; pip_size?: number };
type Settings = { stake: number; dailyLossLimit: number; windowSize: number };
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
  const [settings, setSettings] = useState<Settings>(readSettings);
  const [saved, setSaved] = useState(true);
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | undefined>();

  useEffect(() => {
    let alive = true;
    let socket: WebSocket | null = null;
    const connect = () => {
      if (!alive) return;
      setStatus('CONNECTING');
      socket = new WebSocket(WS);
      ws.current = socket;
      socket.onopen = () => {
        if (!alive || !socket) return;
        setStatus('CONNECTED');
        setError('');
        socket.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic', req_id: 1 }));
        socket.send(JSON.stringify({ ticks_history: symbol, count: 1000, end: 'latest', style: 'ticks', req_id: 2 }));
        socket.send(JSON.stringify({ ticks: symbol, subscribe: 1, req_id: 3 }));
      };
      socket.onmessage = (event) => {
        if (!alive) return;
        try {
          const response = JSON.parse(event.data);
          if (response.error) { setError(response.error.message || 'Deriv API error'); return; }
          if (response.msg_type === 'active_symbols') {
            const list: ActiveSymbol[] = response.active_symbols || [];
            setSymbols(list);
            if (list.length && !list.some((item) => item.underlying_symbol === symbol)) {
              const first = list[0].underlying_symbol;
              if (first) setSymbol(first);
            }
          }
          if (response.msg_type === 'history') {
            const prices: number[] = response.history?.prices || [];
            const times: number[] = response.history?.times || [];
            const history = prices.map((quote, i) => ({ quote: Number(quote), epoch: Number(times[i]) }))
              .filter((tick) => Number.isFinite(tick.quote) && Number.isFinite(tick.epoch));
            setTicks((current) => {
              const merged = new Map<number, Tick>();
              [...history, ...current].forEach((tick) => merged.set(tick.epoch, tick));
              return [...merged.values()].sort((a, b) => a.epoch - b.epoch).slice(-5000);
            });
            if (response.pip_size !== undefined) setPipSize(Number(response.pip_size));
          }
          if (response.msg_type === 'tick' && response.tick) {
            const tick = { quote: Number(response.tick.quote), epoch: Number(response.tick.epoch) };
            if (response.tick.pip_size !== undefined) setPipSize(Number(response.tick.pip_size));
            if (Number.isFinite(tick.quote) && Number.isFinite(tick.epoch)) {
              setTicks((current) => {
                if (current.some((item) => item.epoch === tick.epoch)) return current;
                return [...current, tick].sort((a, b) => a.epoch - b.epoch).slice(-5000);
              });
            }
          }
        } catch { setError('Could not read the Deriv market-data response.'); }
      };
      socket.onerror = () => { if (alive) setError('Deriv WebSocket connection error.'); };
      socket.onclose = () => {
        if (!alive) return;
        setStatus('RECONNECTING');
        reconnectTimer.current = window.setTimeout(connect, 2500);
      };
    };
    connect();
    return () => {
      alive = false;
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
      if (socket) {
        if (socket.readyState === WebSocket.OPEN) {
          try { socket.send(JSON.stringify({ forget_all: 'ticks' })); } catch {}
        }
        socket.close();
      }
      if (ws.current === socket) ws.current = null;
    };
  }, [symbol]);

  useEffect(() => {
    try {
      localStorage.setItem('ddpe-settings-v1', JSON.stringify(settings));
      setSaved(true);
    } catch { setSaved(false); }
  }, [settings]);

  const digits = useMemo(() => ticks.map((tick) => digitFromQuote(tick.quote, pipSize)), [ticks, pipSize]);
  const rollingDigits = digits.slice(-settings.windowSize);
  const stats = useMemo(() => getStats(rollingDigits), [rollingDigits]);
  const overallStats = useMemo(() => getStats(digits), [digits]);
  const marketName = symbols.find((item) => item.underlying_symbol === symbol)?.underlying_symbol_name || symbol;
  const differsEstimate = stats.sample ? (1 - stats.barrierRate) * 100 : 0;
  const changeSetting = (key: keyof Settings, value: number) => {
    setSettings((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };
  const validSettings = settings.stake > 0 && settings.dailyLossLimit > 0 && settings.windowSize >= 50;

  return <main>
    <header className="topbar">
      <div><div className="eyebrow">DDPE · DERIV DIFFERS</div><h1>Digit Prediction Engine</h1><p className="subhead">Live market research and risk controls</p></div>
      <span className={status === 'CONNECTED' ? 'status online' : 'status'}><i />{status}</span>
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
          <select value={symbol} onChange={(event) => setSymbol(event.target.value)}>
            {symbols.map((item) => <option key={item.underlying_symbol} value={item.underlying_symbol}>{item.underlying_symbol_name || item.underlying_symbol}</option>)}
          </select>
        </label>
        <div className="quote"><span>{marketName}</span><strong>{ticks.at(-1)?.quote ?? '—'}</strong><small>{ticks.length.toLocaleString()} ticks collected in this session</small></div>
      </section>

      <section className="overview-grid">
        <div className="panel decision-panel">
          <div className="section-heading">DIFFERS RESEARCH STATUS</div>
          <div className="decision">COLLECTING DATA</div>
          <p className="muted">No live order is being sent. The current repository has no authenticated execution service or validated profitable signal model.</p>
          <div className="divider" />
          <div className="candidate-row"><span>Least frequent digit candidate</span><strong>{stats.barrier >= 0 ? stats.barrier : '—'}</strong></div>
          <div className="candidate-row"><span>Observed Differs rate vs candidate</span><strong>{stats.sample ? differsEstimate.toFixed(2) + '%' : '—'}</strong></div>
          <div className="candidate-row"><span>Reference baseline</span><strong>90.00%</strong></div>
        </div>
        <div className="panel risk-panel">
          <div className="section-heading">RISK SETTINGS</div>
          <div className="risk-value"><span>Stake per trade</span><strong>${settings.stake.toFixed(2)}</strong></div>
          <div className="risk-value"><span>Daily loss stop</span><strong>${settings.dailyLossLimit.toFixed(2)}</strong></div>
          <div className="risk-value"><span>Loss limit usage</span><strong>Not connected</strong></div>
          <button className="secondary-button" onClick={() => setTab('settings')}>Adjust settings</button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title"><div><div className="section-heading">LIVE DIGIT STREAM</div><p className="muted">Latest 60 final quote digits</p></div><span className="live-dot">LIVE FEED</span></div>
        <div className="digits">{digits.slice(-60).map((digit, index, array) => <span key={ticks.slice(-60)[index]?.epoch ?? index} className={index === array.length - 1 ? 'last' : ''}>{digit}</span>)}</div>
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
      <section className="panel">
        <div className="section-heading">ROLLING DIGIT DISTRIBUTION</div>
        <p className="muted">Observed frequencies over the latest {stats.sample} ticks. Frequency alone does not establish a predictive edge.</p>
        <div className="bars">{stats.counts.map((count, digit) => <div className="bar-row" key={digit}><span>{digit}</span><div className="bar-track"><i style={{ width: stats.sample ? (count / stats.sample * 100) + '%' : '0%' }} /></div><b>{count}</b><small>{stats.sample ? (count / stats.sample * 100).toFixed(1) : '0.0'}%</small></div>)}</div>
      </section>
      <section className="panel">
        <div className="section-heading">RECENT TICKS</div>
        <div className="table-wrap"><table><thead><tr><th>Time (UTC)</th><th>Quote</th><th>Last digit</th></tr></thead><tbody>
          {ticks.slice(-25).reverse().map((tick) => <tr key={tick.epoch}><td>{new Date(tick.epoch * 1000).toLocaleTimeString()}</td><td>{tick.quote}</td><td>{digitFromQuote(tick.quote, pipSize)}</td></tr>)}
          {!ticks.length && <tr><td colSpan={3} className="empty">Waiting for tick data…</td></tr>}
        </tbody></table></div>
      </section>
      <section className="panel">
        <div className="section-heading">EXECUTION & PERFORMANCE LOG</div>
        <p className="muted">No orders or settled contracts are recorded. This panel will show proposal prices, contract IDs, outcomes, net P/L and model performance after the execution and database services are connected.</p>
        <div className="empty-state">No executed trades in this build.</div>
      </section>
    </>}

    {tab === 'settings' && <>
      <section className="panel settings-panel">
        <div className="panel-title"><div><div className="section-heading">TRADING RISK</div><p className="muted">Initial limits are set to your requested values.</p></div><span className="saved-state">{saved ? 'Saved on this device' : 'Saving…'}</span></div>
        <label className="setting-field">Stake per trade (USD)
          <div className="input-wrap"><span>$</span><input type="number" min="0.35" max="1000" step="0.01" value={settings.stake} onChange={(event) => changeSetting('stake', Number(event.target.value))} /></div>
          <small>Applied as the proposed contract stake when execution is enabled. Deriv minimums and account currency will still be checked by the backend.</small>
        </label>
        <label className="setting-field">Maximum daily loss (USD)
          <div className="input-wrap"><span>$</span><input type="number" min="0.01" max="10000" step="0.01" value={settings.dailyLossLimit} onChange={(event) => changeSetting('dailyLossLimit', Number(event.target.value))} /></div>
          <small>Hard stop: the execution service must block new purchases once the realised daily net loss reaches this amount.</small>
        </label>
        <label className="setting-field">Analysis window (ticks)
          <div className="input-wrap"><input type="number" min="50" max="5000" step="50" value={settings.windowSize} onChange={(event) => changeSetting('windowSize', Number(event.target.value))} /></div>
          <small>Changes the displayed rolling statistics. It does not by itself improve predictive accuracy.</small>
        </label>
        {!validSettings && <div className="validation-error">Enter positive stake and loss values, and a window of at least 50 ticks.</div>}
        <div className="settings-actions"><button className="secondary-button" onClick={() => setSettings(DEFAULT_SETTINGS)}>Restore defaults</button><span className="default-note">Defaults: $1 stake · $2 daily loss</span></div>
      </section>
      <section className="panel safety-panel">
        <div className="section-heading">EXECUTION SAFETY</div>
        <ul>
          <li>Live trading remains disabled in this build.</li>
          <li>Risk settings currently persist in this browser only. They are not yet stored in Neon or enforced by a server-side worker.</li>
          <li>Before enabling execution, the backend must revalidate limits, track settled net P/L by Uganda-local trading day, and reject duplicate orders.</li>
        </ul>
      </section>
    </>}

    <footer>DDPE research interface · public Deriv tick feed · no order execution in this build</footer>
  </main>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="panel metric-card"><span>{label}</span><strong>{value}</strong></div>;
}

createRoot(document.getElementById('root')!).render(<App />);
