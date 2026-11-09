import React, { useEffect, useMemo, useRef, useState } from 'react';
import './scalper.css';

type Market = { symbol: string; name: string; supported: boolean | null; contracts: string[]; ticks: number[]; last: number | null; updatedAt: number | null; error?: string };
type Trade = { id: string; symbol: string; direction: 'MULTUP' | 'MULTDOWN'; stake: number; multiplier: number; buyPrice: number; status: string; pnl: number; openedAt: number; closedAt?: number };
type Props = { demoConnected: boolean; demoAccountId: string; demoCurrency: string };
const PUBLIC_WS = 'wss://api.derivws.com/trading/v1/options/ws/public';
const HISTORY_KEY = 'lotus-scalper-trades-v1';
const DAILY_KEY = 'lotus-scalper-daily-v1';
const STAKE = 0.35;
const MULTIPLIER = 10;
const DAILY_STOP = 1.00;
const TAKE_PROFIT = 0.35;
const STOP_LOSS = 0.35;
const COOLDOWN_MS = 60000;

function crashBoom(item: any) {
  return /crash|boom/i.test(String(item?.underlying_symbol || '') + ' ' + String(item?.underlying_symbol_name || ''));
}
function getContractTypes(value: any, output = new Set<string>(), seen = new Set<any>()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) value.forEach(item => getContractTypes(item, output, seen));
  else {
    if (typeof value.contract_type === 'string') output.add(value.contract_type);
    Object.values(value).forEach(item => getContractTypes(item, output, seen));
  }
  return output;
}
function momentum(ticks: number[]) {
  if (ticks.length < 11) return null;
  const recent = ticks.slice(-11);
  let up = 0, down = 0;
  for (let i = 1; i < recent.length; i += 1) {
    if (recent[i] > recent[i - 1]) up += 1;
    if (recent[i] < recent[i - 1]) down += 1;
  }
  if (up >= 9) return 'MULTUP' as const;
  if (down >= 9) return 'MULTDOWN' as const;
  return null;
}
function loadTrades(): Trade[] {
  try { const data = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); return Array.isArray(data) ? data : []; } catch { return []; }
}

export default function CrashBoomScalper({ demoConnected, demoAccountId, demoCurrency }: Props) {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [scanState, setScanState] = useState('NOT SCANNED');
  const [scanError, setScanError] = useState('');
  const [selected, setSelected] = useState('');
  const [demoState, setDemoState] = useState('DISCONNECTED');
  const [botRunning, setBotRunning] = useState(false);
  const [trades, setTrades] = useState<Trade[]>(loadTrades);
  const [dailyPnl, setDailyPnl] = useState(0);
  const [lastTradeAt, setLastTradeAt] = useState(0);
  const [pendingMessage, setPendingMessage] = useState('No trade submitted');
  const [lastSignal, setLastSignal] = useState('Waiting for market scan');
  const publicSocket = useRef<WebSocket | null>(null);
  const demoSocket = useRef<WebSocket | null>(null);
  const marketsRef = useRef<Map<string, Market>>(new Map());
  const proposalRequests = useRef<Map<number, {symbol:string;direction:'MULTUP'|'MULTDOWN'}>>(new Map());
  const requestId = useRef(5000);
  const openTradeId = useRef<string | null>(null);
  const botRef = useRef(false);
  const lastTradeRef = useRef(0);
  const dailyPnlRef = useRef(0);
  const tradeMap = useRef<Map<string, Trade>>(new Map());

  useEffect(() => {
    const day = new Date().toISOString().slice(0, 10);
    try {
      const saved = JSON.parse(localStorage.getItem(DAILY_KEY) || '{}');
      if (saved.day === day && Number.isFinite(saved.pnl)) setDailyPnl(saved.pnl);
      else localStorage.setItem(DAILY_KEY, JSON.stringify({day, pnl:0}));
    } catch { localStorage.setItem(DAILY_KEY, JSON.stringify({day, pnl:0})); }
    return () => { publicSocket.current?.close(); demoSocket.current?.close(); };
  }, []);
  useEffect(() => { localStorage.setItem(HISTORY_KEY, JSON.stringify(trades.slice(-100))); }, [trades]);
  useEffect(() => { botRef.current = botRunning; }, [botRunning]);
  useEffect(() => { dailyPnlRef.current = dailyPnl; }, [dailyPnl]);

  function updateMarket(symbol: string, patch: Partial<Market>) {
    const current = marketsRef.current.get(symbol);
    if (!current) return;
    const next = { ...current, ...patch };
    marketsRef.current.set(symbol, next);
    setMarkets(Array.from(marketsRef.current.values()));
  }
  function connectPublicScanner() {
    publicSocket.current?.close();
    marketsRef.current.clear();
    setMarkets([]);
    setScanError('');
    setScanState('CONNECTING');
    const socket = new WebSocket(PUBLIC_WS);
    publicSocket.current = socket;
    socket.onopen = () => {
      setScanState('DISCOVERING');
      socket.send(JSON.stringify({ active_symbols: 'brief', contract_type: ['MULTUP', 'MULTDOWN'], req_id: 1 }));
    };
    socket.onerror = () => { setScanState('CONNECTION ERROR'); setScanError('Could not connect to the public Deriv market-data endpoint.'); };
    socket.onclose = () => { if (publicSocket.current === socket) setScanState('DISCONNECTED'); };
    socket.onmessage = event => {
      let data: any;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.error) {
        setScanError(data.error.message || 'Deriv market-data request failed.');
        if (Number(data.req_id) === 1) setScanState('DISCOVERY FAILED');
        return;
      }
      if (data.msg_type === 'active_symbols') {
        const list = (data.active_symbols || []).filter(crashBoom);
        if (!list.length) { setScanState('NO CRASH/BOOM SYMBOLS'); return; }
        list.forEach((item: any, index: number) => {
          const symbol = String(item.underlying_symbol || '');
          if (!symbol) return;
          marketsRef.current.set(symbol, { symbol, name: item.underlying_symbol_name || symbol, supported: null, contracts: [], ticks: [], last: null, updatedAt: null });
          window.setTimeout(() => {
            if (socket.readyState !== WebSocket.OPEN) return;
            socket.send(JSON.stringify({ contracts_for: symbol, req_id: 100 + index }));
            socket.send(JSON.stringify({ ticks_history: symbol, count: 120, end: 'latest', style: 'ticks', req_id: 1000 + index }));
            socket.send(JSON.stringify({ ticks: symbol, subscribe: 1, req_id: 2000 + index }));
          }, index * 90);
        });
        setMarkets(Array.from(marketsRef.current.values()));
        setScanState('VERIFYING CONTRACTS');
      }
      if (data.msg_type === 'contracts_for') {
        const symbol = String(data.echo_req?.contracts_for || data.passthrough?.symbol || '');
        if (!symbol || !marketsRef.current.has(symbol)) return;
        const types = Array.from(getContractTypes(data.contracts || data));
        const supported = types.includes('MULTUP') && types.includes('MULTDOWN');
        updateMarket(symbol, { contracts: types.filter(t => t === 'MULTUP' || t === 'MULTDOWN'), supported, error: supported ? undefined : 'Multipliers not listed for this instrument' });
        const all = Array.from(marketsRef.current.values());
        if (all.every(m => m.supported !== null)) setScanState('VERIFIED');
      }
      if (data.msg_type === 'history') {
        const symbol = String(data.echo_req?.ticks_history || '');
        if (!symbol || !marketsRef.current.has(symbol)) return;
        const prices = (data.history?.prices || []).map((v: any) => Number(v)).filter(Number.isFinite);
        const current = marketsRef.current.get(symbol)!;
        updateMarket(symbol, { ticks: prices.slice(-500), last: prices.at(-1) ?? current.last, updatedAt: Date.now() });
      }
      if (data.msg_type === 'tick') {
        const symbol = String(data.tick?.symbol || '');
        if (!symbol || !marketsRef.current.has(symbol)) return;
        const current = marketsRef.current.get(symbol)!;
        const ticks = [...current.ticks, Number(data.tick.quote)].filter(Number.isFinite).slice(-500);
        updateMarket(symbol, { ticks, last: Number(data.tick.quote), updatedAt: Date.now() });
        const direction = momentum(ticks);
        if (direction) setLastSignal(symbol + ' · ' + direction + ' · 9/10 directional moves');
        if (botRef.current && direction && selected === symbol) requestDemoProposal(symbol, direction);
      }
    };
  }

  async function connectDemo() {
    if (!demoConnected || !demoAccountId) { setPendingMessage('Connect and select a verified Deriv demo account in Lotus Settings first.'); return; }
    setDemoState('REQUESTING OTP');
    try {
      const response = await fetch('/api/deriv/demo/otp', { method:'POST', credentials:'same-origin', headers:{'content-type':'application/json'}, body:JSON.stringify({account_id:demoAccountId}) });
      const result = await response.json();
      if (!response.ok || typeof result.websocket_url !== 'string' || !result.websocket_url.startsWith('wss://api.derivws.com/trading/v1/options/ws/demo?otp=')) throw new Error(result.error || 'A verified demo WebSocket URL was not returned.');
      demoSocket.current?.close();
      const socket = new WebSocket(result.websocket_url);
      demoSocket.current = socket;
      socket.onopen = () => { setDemoState('DEMO CONNECTED'); setPendingMessage('Authenticated demo session ready. No real-account endpoint is used.'); };
      socket.onerror = () => setDemoState('CONNECTION ERROR');
      socket.onclose = () => { if (demoSocket.current === socket) { setDemoState('DISCONNECTED'); setBotRunning(false); } };
      socket.onmessage = event => {
        let data: any;
        try { data = JSON.parse(event.data); } catch { return; }
        if (data.error) { setPendingMessage(data.error.message || 'Demo trading request rejected.'); return; }
        if (data.msg_type === 'proposal') {
          const req = proposalRequests.current.get(Number(data.req_id));
          if (!req) return;
          proposalRequests.current.delete(Number(data.req_id));
          const proposal = data.proposal;
          const ask = Number(proposal?.ask_price);
          if (!proposal?.id || !Number.isFinite(ask) || ask <= 0) { setPendingMessage('Deriv returned an invalid Multiplier proposal.'); return; }
          if (!botRef.current || openTradeId.current || dailyPnlRef.current <= -DAILY_STOP) return;
          const buyReq = requestId.current++;
          proposalRequests.current.set(buyReq, { ...req, symbol: req.symbol + '|BUY|' + String(proposal.id) });
          socket.send(JSON.stringify({ buy: String(proposal.id), price: ask, req_id: buyReq }));
          setPendingMessage('Buying quoted demo contract…');
        }
        if (data.msg_type === 'buy' && data.buy) {
          const req = proposalRequests.current.get(Number(data.req_id));
          if (!req) return;
          proposalRequests.current.delete(Number(data.req_id));
          const parts = req.symbol.split('|BUY|');
          const symbol = parts[0];
          const contractId = String(data.buy.contract_id || '');
          if (!contractId) { setPendingMessage('Deriv did not return a contract ID.'); return; }
          openTradeId.current = contractId;
          const trade: Trade = { id:contractId, symbol, direction:req.direction, stake:STAKE, multiplier:MULTIPLIER, buyPrice:Number(data.buy.buy_price || 0), status:'OPEN', pnl:0, openedAt:Date.now() };
          tradeMap.current.set(contractId, trade);
          setTrades(previous => [...previous, trade]);
          setPendingMessage('Demo contract opened · monitoring settlement and P/L.');
          socket.send(JSON.stringify({ proposal_open_contract:1, contract_id:contractId, subscribe:1, req_id:requestId.current++ }));
        }
        if (data.msg_type === 'proposal_open_contract' && data.proposal_open_contract) {
          const contract = data.proposal_open_contract;
          const id = String(contract.contract_id || '');
          const previous = tradeMap.current.get(id);
          if (!previous) return;
          const profit = Number(contract.profit);
          const closed = Boolean(contract.is_sold) || ['won','lost','sold'].includes(String(contract.status || '').toLowerCase());
          const next: Trade = { ...previous, pnl:Number.isFinite(profit) ? profit : previous.pnl, status:closed ? String(contract.status || 'SETTLED').toUpperCase() : 'OPEN', closedAt:closed ? Date.now() : undefined };
          tradeMap.current.set(id, next);
          setTrades(items => items.map(item => item.id === id ? next : item));
          if (closed) {
            openTradeId.current = null;
            if (Number.isFinite(profit)) {
              const nextPnl = dailyPnlRef.current + profit;
              dailyPnlRef.current = nextPnl;
              setDailyPnl(nextPnl);
              localStorage.setItem(DAILY_KEY, JSON.stringify({day:new Date().toISOString().slice(0,10),pnl:nextPnl}));
            }
            setPendingMessage('Demo contract settled · result recorded locally.');
            setLastTradeAt(Date.now());
          }
        }
      };
    } catch (error) { setDemoState('NOT CONNECTED'); setPendingMessage(error instanceof Error ? error.message : 'Demo connection failed.'); }
  }

  function requestDemoProposal(symbol: string, direction: 'MULTUP'|'MULTDOWN') {
    const socket = demoSocket.current;
    const market = marketsRef.current.get(symbol);
    if (!botRef.current || !socket || socket.readyState !== WebSocket.OPEN || !market?.supported) return;
    if (openTradeId.current || dailyPnlRef.current <= -DAILY_STOP || Date.now() - lastTradeRef.current < COOLDOWN_MS) return;
    if (proposalRequests.current.size) return;
    lastTradeRef.current = Date.now();
    const id = requestId.current++;
    proposalRequests.current.set(id, { symbol, direction });
    socket.send(JSON.stringify({ proposal:1, amount:STAKE, basis:'stake', contract_type:direction, currency:demoCurrency, multiplier:MULTIPLIER, underlying_symbol:symbol, limit_order:{take_profit:TAKE_PROFIT,stop_loss:STOP_LOSS}, req_id:id }));
    setPendingMessage('Requesting live demo quote for ' + symbol + ' ' + direction + '…');
  }

  function startBot() {
    if (scanState !== 'VERIFIED' || !markets.some(m => m.symbol === selected && m.supported) || demoState !== 'DEMO CONNECTED' || !demoCurrency) return;
    if (dailyPnl <= -DAILY_STOP) { setPendingMessage('Daily demo loss limit reached. Bot remains stopped.'); return; }
    setBotRunning(true);
    setPendingMessage('Demo scalper armed. It waits for a 9-of-10 tick-direction trigger.');
  }
  function stopBot() { setBotRunning(false); setPendingMessage('Bot stopped. Any open demo contract remains with Deriv until settled or managed there.'); }
  const eligible = markets.filter(m => m.supported);
  const activeTrade = trades.find(t => t.status === 'OPEN');
  const selectedMarket = markets.find(m => m.symbol === selected);
  const signal = selectedMarket ? momentum(selectedMarket.ticks) : null;

  return <section className="scalper-root">
    <div className="scalper-heading"><div><div className="section-heading">LOTUS · CRASH / BOOM SCALPER</div><h2>Demo execution lab</h2><p className="muted">Multipliers API execution plus a separate MT5 Expert Advisor route. This module does not modify Differs / Matches.</p></div><span className="execution-lock">DEMO ONLY</span></div>
    <div className="scalper-kpis">
      <div className="panel"><span>INSTRUMENTS VERIFIED</span><strong>{eligible.length} / {markets.length}</strong><small>{scanState}</small></div>
      <div className="panel"><span>DEMO SESSION</span><strong>{demoState}</strong><small>{demoAccountId || 'No demo account selected'}</small></div>
      <div className="panel"><span>DAILY DEMO P/L</span><strong>{dailyPnl.toFixed(2)} {demoCurrency}</strong><small>Local session journal · stop at -{DAILY_STOP.toFixed(2)}</small></div>
      <div className="panel"><span>OPEN CONTRACTS</span><strong>{activeTrade ? '1' : '0'}</strong><small>Maximum one concurrent contract</small></div>
    </div>
    <div className="panel">
      <div className="panel-title"><div><div className="section-heading">1 · DISCOVER AND VERIFY</div><p className="muted">Queries Deriv active_symbols for MULTUP / MULTDOWN, then checks contracts_for on each Crash/Boom instrument. No guessed symbols.</p></div><span className="live-dot">{scanState}</span></div>
      <div className="scalper-actions"><button className="secondary-button" onClick={connectPublicScanner}>SCAN DERIV INSTRUMENTS</button><button className="secondary-button" onClick={()=>{publicSocket.current?.close();setScanState('STOPPED')}}>STOP SCAN</button></div>
      {scanError && <p className="error">{scanError}</p>}
      <div className="table-wrap"><table><thead><tr><th>Instrument</th><th>Multipliers UP</th><th>Multipliers DOWN</th><th>Ticks cached</th><th>Last quote</th></tr></thead><tbody>
        {markets.map(m=><tr key={m.symbol}><td><button className="text-button" onClick={()=>setSelected(m.symbol)}>{m.name}</button><small className="scalper-symbol">{m.symbol}</small></td><td>{m.supported === null ? 'Checking…' : m.contracts.includes('MULTUP') ? 'Supported' : 'Unavailable'}</td><td>{m.supported === null ? 'Checking…' : m.contracts.includes('MULTDOWN') ? 'Supported' : 'Unavailable'}</td><td>{m.ticks.length}</td><td>{m.last ?? '—'}</td></tr>)}
        {!markets.length && <tr><td colSpan={5} className="empty">Run the instrument scan to discover the Crash/Boom symbols and supported contract types.</td></tr>}
      </tbody></table></div>
      <p className="muted">A symbol is eligible only when Deriv's returned contract metadata explicitly includes both MULTUP and MULTDOWN. If only one direction is listed, the current two-way filter keeps it out until the scanner is refined.</p>
    </div>
    <div className="scalper-columns">
      <div className="panel">
        <div className="section-heading">2 · MULTIPLIERS · DERIV DEMO</div>
        <p className="muted">The app requests a fresh demo OTP through the existing encrypted OAuth backend. The backend rejects real accounts and only returns the demo WebSocket URL.</p>
        <div className="candidate-row"><span>Selected instrument</span><strong>{selectedMarket?.name || 'Select a verified market'}</strong></div>
        <label className="setting-field">Crash / Boom instrument
          <select value={selected} onChange={e=>setSelected(e.target.value)}><option value="">Select verified instrument</option>{eligible.map(m=><option key={m.symbol} value={m.symbol}>{m.name} · {m.symbol}</option>)}</select>
        </label>
        <div className="candidate-row"><span>Current trigger</span><strong>{signal || 'No trigger'}</strong></div>
        <div className="candidate-row"><span>Demo stake / multiplier</span><strong>{STAKE.toFixed(2)} · {MULTIPLIER}x</strong></div>
        <div className="candidate-row"><span>Per-contract TP / SL</span><strong>{TAKE_PROFIT.toFixed(2)} / {STOP_LOSS.toFixed(2)}</strong></div>
        <div className="candidate-row"><span>Cooldown</span><strong>60 seconds</strong></div>
        <div className="scalper-actions"><button className="secondary-button" disabled={!demoConnected || !demoAccountId || demoState==='DEMO CONNECTED'} onClick={connectDemo}>CONNECT DEMO EXECUTION</button><span className="scalper-state">{demoState}</span></div>
        <div className="scalper-actions"><button className="start-button" disabled={botRunning || demoState!=='DEMO CONNECTED' || scanState!=='VERIFIED' || !selectedMarket?.supported || !demoCurrency || dailyPnl<=-DAILY_STOP} onClick={startBot}>START DEMO SCALPER</button><button className="stop-button" disabled={!botRunning} onClick={stopBot}>STOP BOT</button></div>
        <p className="lock-note">{botRunning ? 'AUTOMATION ARMED · DEMO ONLY' : 'AUTOMATION DISARMED'}</p>
        <p className="muted" aria-live="polite">{pendingMessage}</p>
      </div>
      <div className="panel">
        <div className="section-heading">3 · MT5 CFDs · SEPARATE TERMINAL BRIDGE</div>
        <p className="muted">Deriv's MT5 account APIs do not provide trade execution. This route requires the Lotus MQL5 Expert Advisor to run inside a Deriv MT5 desktop terminal on a demo account.</p>
        <div className="candidate-row"><span>Execution route</span><strong>MT5 Expert Advisor</strong></div>
        <div className="candidate-row"><span>Web / mobile execution</span><strong>Not supported by MT5 EA</strong></div>
        <div className="candidate-row"><span>Account restriction</span><strong>Demo account only</strong></div>
        <a className="scalper-download" href="/mt5/LotusCrashBoomDemoEA.mq5" download>Download Lotus MT5 Demo EA</a>
        <p className="muted">Attach the EA to a Crash or Boom chart in MT5 desktop. Verify the exact broker symbol in Market Watch. The EA checks the terminal account mode and refuses to trade unless it is DEMO.</p>
      </div>
    </div>
    <div className="panel">
      <div className="panel-title"><div><div className="section-heading">4 · DEMO TRADE JOURNAL</div><p className="muted">Trades recorded in this browser only. Reconcile with Deriv account history after testing.</p></div></div>
      <div className="table-wrap"><table><thead><tr><th>Opened</th><th>Market</th><th>Direction</th><th>Stake</th><th>Status</th><th>Demo P/L</th></tr></thead><tbody>
        {[...trades].reverse().slice(0,30).map(t=><tr key={t.id}><td>{new Date(t.openedAt).toLocaleTimeString()}</td><td>{t.symbol}</td><td>{t.direction}</td><td>{t.stake.toFixed(2)}</td><td>{t.status}</td><td>{t.pnl.toFixed(2)}</td></tr>)}
        {!trades.length && <tr><td colSpan={6} className="empty">No demo contracts have been submitted by this scalper.</td></tr>}
      </tbody></table></div>
    </div>
    <div className="scalper-warning"><strong>Important execution limitations</strong><p>The experimental trigger is 9 of the last 10 price changes in one direction. It is a test trigger, not a validated edge. Crash/Boom spike frequencies are averages, not countdowns. Demo stake, daily loss stop, one-position limit and cooldown are enforced in this browser session only, not by a server-side order gateway. Keep the demo balance small and do not treat this as production-safe automation. Closing this page stops the bot; any open contract remains on Deriv.</p></div>
  </section>;
}
