import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const WS = 'wss://ws.binaryws.com/websockets/v3';

type Tick = { quote: number; epoch: number };
type ActiveSymbol = { underlying_symbol: string; underlying_symbol_name?: string; pip_size?: number };

function digitFromQuote(q: number, pip?: number): number {
  if (!Number.isFinite(q)) return 0;
  const decimals = pip && pip > 0 ? Math.max(0, Math.round(-Math.log10(pip))) : ((String(q).split('.')[1] || '').length);
  return Number(q.toFixed(decimals).replace(/\D/g, '').slice(-1) || 0);
}

function stats(ds: number[]) {
  const c = Array<number>(10).fill(0);
  ds.forEach((d) => { if (Number.isInteger(d) && d >= 0 && d <= 9) c[d]++; });
  const n = ds.length;
  const probs = c.map((x) => (n ? x / n : 0));
  const max = n ? Math.max(...probs) : 0;
  const d = n ? probs.indexOf(max) : 0;
  const entropy = n ? -probs.reduce((a, p) => a + (p ? p * Math.log2(p) : 0), 0) : 0;
  return { c, probs, max, d, entropy };
}

function App() {
  const [symbol, setSymbol] = useState('1HZ100V');
  const [symbols, setSymbols] = useState<ActiveSymbol[]>([]);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [pipSize, setPipSize] = useState<number | undefined>();
  const [status, setStatus] = useState('CONNECTING');
  const [error, setError] = useState('');
  const ws = useRef<WebSocket | null>(null);
  const timer = useRef<number | undefined>();

  useEffect(() => {
    let alive = true;
    const connect = () => {
      if (!alive) return;
      const w = new WebSocket(WS);
      ws.current = w;
      w.onopen = () => {
        if (!alive) return;
        setStatus('CONNECTED'); setError('');
        w.send(JSON.stringify({ active_symbols: 'brief', req_id: 1 }));
        w.send(JSON.stringify({ ticks_history: symbol, count: 1000, end: 'latest', style: 'ticks', req_id: 2 }));
        w.send(JSON.stringify({ ticks: symbol, subscribe: 1, req_id: 3 }));
      };
      w.onmessage = (event) => {
        if (!alive) return;
        try {
          const x = JSON.parse(event.data);
          if (x.error) { setError(x.error.message || 'Deriv API error'); return; }
          if (x.msg_type === 'active_symbols') setSymbols(x.active_symbols || []);
          if (x.msg_type === 'history') {
            const prices: number[] = x.history?.prices || [];
            const times: number[] = x.history?.times || [];
            setTicks(prices.map((quote, i) => ({ quote: Number(quote), epoch: Number(times[i]) })));
            if (x.pip_size !== undefined) setPipSize(Number(x.pip_size));
          }
          if (x.msg_type === 'tick' && x.tick) {
            const t = { quote: Number(x.tick.quote), epoch: Number(x.tick.epoch) };
            if (x.tick.pip_size !== undefined) setPipSize(Number(x.tick.pip_size));
            setTicks((a) => [...a, t].slice(-5000));
          }
        } catch { setError('Invalid response received from Deriv.'); }
      };
      w.onerror = () => { if (alive) setError('WebSocket connection error'); };
      w.onclose = () => {
        if (!alive) return;
        setStatus('RECONNECTING');
        timer.current = window.setTimeout(connect, 2000);
      };
    };
    setStatus('CONNECTING');
    connect();
    return () => {
      alive = false;
      if (timer.current) window.clearTimeout(timer.current);
      if (ws.current?.readyState === WebSocket.OPEN) {
        try { ws.current.send(JSON.stringify({ forget_all: 'ticks' })); } catch {}
        ws.current.close();
      }
    };
  }, [symbol]);

  const ds = useMemo(() => ticks.map((t) => digitFromQuote(t.quote, pipSize)), [ticks, pipSize]);
  const s = useMemo(() => stats(ds.slice(-100)), [ds]);
  const long = useMemo(() => stats(ds), [ds]);
  const edge = (s.probs[s.d] - 0.1) * 100;
  const signal = ds.length >= 100 && s.max >= 0.13 && edge > 2 ? 'MATCH' : 'WAIT';
  const marketName = symbols.find((x) => x.underlying_symbol === symbol)?.underlying_symbol_name || symbol;

  return <main>
    <header><div><div className="eyebrow">DERIV DIGIT AI · V1</div><h1>Digit Research Console</h1></div><span className={status === 'CONNECTED' ? 'ok' : 'warn'}>{status}</span></header>
    <section className="panel controls"><label>Market<select value={symbol} onChange={(e) => setSymbol(e.target.value)}>{symbols.filter((x) => (x.underlying_symbol || '').includes('V')).slice(0,100).map((x) => <option key={x.underlying_symbol} value={x.underlying_symbol}>{x.underlying_symbol_name || x.underlying_symbol}</option>)}</select></label><div className="ticker">{marketName}<b>{ticks.at(-1)?.quote ?? '—'}</b></div></section>
    {error && <div className="error">{error}</div>}
    <section className="grid"><div className="panel hero"><div className="eyebrow">CURRENT DECISION</div><div className={'signal ' + signal.toLowerCase()}>{signal}</div><div className="candidate">Candidate digit: <b>{ds.length ? s.d : '—'}</b></div><div className="metrics"><div><span>100-tick P</span><b>{(s.max*100).toFixed(1)}%</b></div><div><span>Baseline</span><b>10.0%</b></div><div><span>Edge vs baseline</span><b>{edge.toFixed(1)}pp</b></div><div><span>Entropy</span><b>{s.entropy.toFixed(2)}</b></div></div><p className="note">V1 is research-only. A frequency anomaly is not proof of predictive edge.</p></div>
      <div className="panel"><div className="eyebrow">LAST 100 DIGITS</div><div className="bars">{s.c.map((n,i)=><div className="barrow" key={i}><span>{i}</span><div><i style={{width:`${n}%`}}/></div><b>{n}</b></div>)}</div></div></section>
    <section className="panel"><div className="eyebrow">LIVE DIGIT STREAM</div><div className="digits">{ds.slice(-80).map((d,i,a)=><span key={i} className={i===a.length-1?'last':''}>{d}</span>)}</div></section>
    <section className="grid"><div className="panel"><div className="eyebrow">VALIDATION GATE</div><ul><li>Live data: {ticks.length?'PASS':'WAIT'}</li><li>Sample size: {ds.length}</li><li>Rolling anomaly: {s.max>=0.13?'DETECTED':'NONE'}</li><li>Out-of-sample validation: <b>NOT YET RUN</b></li><li>EV/payout validation: <b>NOT YET RUN</b></li></ul></div><div className="panel"><div className="eyebrow">LONG WINDOW</div><div className="big">{(long.max*100).toFixed(2)}%</div><div>Most frequent digit: <b>{ds.length?long.d:'—'}</b></div><div>Sample: {ds.length} ticks</div></div></section>
    <footer>Public market-data mode · no account token · no automated orders</footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
