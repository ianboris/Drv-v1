import { gunzipSync } from 'node:zlib';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const RESEARCH_WINDOWS = [100, 500, 1000, 5000];
const CONTRACTS = ['DIFFERS', 'MATCHES', 'EVEN', 'ODD'];

export function wilson95(successes, total) {
  if (!total) return { lower: null, upper: null };
  const z = 1.959963984540054, p = successes / total, z2 = z * z;
  const d = 1 + z2 / total;
  const c = (p + z2 / (2 * total)) / d;
  const m = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total) / d;
  return { lower: Math.max(0, c - m), upper: Math.min(1, c + m) };
}

export async function loadResearchTicks(directory) {
  const names = (await readdir(directory)).filter(n =>
    /^ticks-\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(n) ||
    /^batch-v1-[a-f0-9]{64}\.jsonl\.gz$/.test(n)).sort();
  const symbols = new Map();
  for (const name of names) {
    const text = gunzipSync(await readFile(join(directory, name))).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const epoch = Number(row.epoch), digit = Number(row.digit);
      if (!row.symbol || !Number.isSafeInteger(epoch) || !Number.isInteger(digit) || digit < 0 || digit > 9) continue;
      if (!symbols.has(row.symbol)) symbols.set(row.symbol, []);
      symbols.get(row.symbol).push({
        symbol: row.symbol, epoch, digit, source: row.source === 'backfill' ? 'backfill' : row.source === 'live' ? 'live' : 'unknown',
        tickUid: String(row.tick_uid || '')
      });
    }
  }
  for (const [symbol, rows] of symbols) {
    rows.sort((a,b) => a.epoch - b.epoch || a.tickUid.localeCompare(b.tickUid));
    const seen = new Set();
    symbols.set(symbol, rows.filter(row => {
      if (!row.tickUid) return true;
      const key = row.tickUid;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }));
  }
  return symbols;
}

function frequencies(digits) {
  const counts = Array(10).fill(0);
  for (const d of digits) counts[d]++;
  return { counts, probabilities: counts.map(x => digits.length ? x / digits.length : 0) };
}

function scorePredictions(rows, start, end, window) {
  const counts = Array(10).fill(0.5);
  for (let j = start - window; j < start; j++) counts[rows[j].digit]++;
  let logLoss = 0, brier = 0, n = 0, wins = 0;
  const parity = { EVEN: { wins: 0, n: 0 }, ODD: { wins: 0, n: 0 } };
  for (let i = start; i < end; i++) {
    const total = counts.reduce((a,b) => a+b, 0);
    const p = counts.map(x => x / total);
    const actual = rows[i].digit;
    logLoss -= Math.log(Math.max(1e-12, p[actual]));
    for (let d=0; d<10; d++) brier += (p[d] - (actual === d ? 1 : 0)) ** 2;
    n++;
    parity[actual % 2 ? 'ODD' : 'EVEN'].wins++;
    parity.EVEN.n++; parity.ODD.n++;
    counts[rows[i-window].digit]--;
    counts[actual]++;
  }
  return { observations: n, meanLogLoss: n ? logLoss/n : null, meanBrier: n ? brier/n : null };
}

function contractDiagnostics(digits) {
  const n = digits.length, counts = frequencies(digits).counts;
  const even = digits.filter(d => d % 2 === 0).length;
  const contracts = [];
  for (let d=0; d<10; d++) {
    const matches = counts[d], differs = n - matches;
    contracts.push({
      contract: 'MATCHES', targetDigit: d, wins: matches, observations: n,
      winRate: n ? matches/n : null, confidence95: wilson95(matches,n),
      theoreticalIIDBaseline: 0.1
    });
    contracts.push({
      contract: 'DIFFERS', targetDigit: d, wins: differs, observations: n,
      winRate: n ? differs/n : null, confidence95: wilson95(differs,n),
      theoreticalIIDBaseline: 0.9
    });
  }
  for (const [contract,wins] of [['EVEN',even],['ODD',n-even]]) {
    contracts.push({ contract, targetDigit: null, wins, observations: n,
      winRate: n ? wins/n : null, confidence95: wilson95(wins,n), theoreticalIIDBaseline: 0.5 });
  }
  return contracts;
}

export function analyzeSymbolTicks(rows, windows = RESEARCH_WINDOWS) {
  const ordered = [...rows].sort((a,b) => a.epoch-b.epoch);
  const digits = ordered.map(r=>r.digit);
  const live = ordered.filter(r=>r.source==='live').length;
  const backfill = ordered.filter(r=>r.source==='backfill').length;
  const result = {
    symbol: ordered[0]?.symbol || null, totalTicks: ordered.length, liveTicks: live,
    backfillTicks: backfill, unknownSourceTicks: ordered.length-live-backfill,
    firstEpoch: ordered[0]?.epoch ?? null, lastEpoch: ordered.at(-1)?.epoch ?? null,
    windows: [], contracts: contractDiagnostics(digits),
    split: { trainingEnd: Math.floor(ordered.length*.6), validationEnd: Math.floor(ordered.length*.8),
      validationShare: .2, holdoutShare: .2 },
    validation: {}, holdout: {},
    warnings: []
  };
  for (const size of windows) {
    if (digits.length < size) continue;
    const sample = digits.slice(-size), f = frequencies(sample);
    const parityEven = sample.filter(d=>d%2===0).length;
    result.windows.push({
      size, counts: f.counts, probabilities: f.probabilities,
      even: parityEven, odd: size-parityEven,
      evenRate: parityEven/size, oddRate: (size-parityEven)/size,
      mostFrequentDigit: f.counts.indexOf(Math.max(...f.counts)),
      leastFrequentDigit: f.counts.indexOf(Math.min(...f.counts))
    });
  }
  const validationStart = Math.floor(ordered.length*.6), holdoutStart = Math.floor(ordered.length*.8);
  for (const size of windows) {
    if (validationStart < size || ordered.length-holdoutStart < 1) continue;
    result.validation[size] = scorePredictions(ordered, Math.max(validationStart,size), holdoutStart, size);
    result.holdout[size] = scorePredictions(ordered, Math.max(holdoutStart,size), ordered.length, size);
  }
  if (ordered.length < 6000) result.warnings.push('Fewer than 6,000 unique ticks: larger-window and holdout estimates may be noisy.');
  if (live < 1000) result.warnings.push('Fewer than 1,000 live ticks: do not treat live-only estimates as execution evidence.');
  result.warnings.push('Frequency imbalance is descriptive, not proof of predictive edge. Do not infer future outcomes from a hot/cold digit.');
  result.warnings.push('No historical proposal prices are stored with each tick; historical payout-adjusted P/L cannot be reconstructed from tick archives alone.');
  return result;
}

export function evaluateLivePayouts(probabilities, symbol, snapshots, stake, currency, now = Date.now()) {
  if (!Array.isArray(probabilities) || probabilities.length !== 10) throw new Error('Expected ten digit probabilities.');
  const fresh = snapshots.filter(q => q.symbol === symbol && String(q.currency).toUpperCase() === currency.toUpperCase() &&
    Number(q.stake) === Number(stake) && Number.isFinite(Date.parse(q.capturedAt)) &&
    now - Date.parse(q.capturedAt) >= 0 && now - Date.parse(q.capturedAt) <= 30000);
  const candidates = [];
  for (const q of fresh) {
    const type = String(q.contractType || q.contract_type || '').toUpperCase();
    const target = q.barrier == null ? null : Number(q.barrier);
    const payout = Number(q.payout), ask = Number(q.askPrice ?? q.ask_price);
    if (!(ask > 0 && payout > ask)) continue;
    let pWin;
    if (type === 'DIFFERS' || type === 'DIGITDIFF') pWin = 1-probabilities[target];
    else if (type === 'MATCHES' || type === 'DIGITMATCH') pWin = probabilities[target];
    else if (type === 'EVEN' || type === 'DIGITEVEN') pWin = probabilities.filter((_,i)=>i%2===0).reduce((a,b)=>a+b,0);
    else if (type === 'ODD' || type === 'DIGITODD') pWin = probabilities.filter((_,i)=>i%2===1).reduce((a,b)=>a+b,0);
    else continue;
    const expectedNet = pWin*payout-ask;
    candidates.push({ contract: type, targetDigit: target, pWin, breakEvenProbability: ask/payout,
      askPrice: ask, grossPayout: payout, expectedNet, expectedReturnOnStake: expectedNet/ask,
      capturedAt: q.capturedAt, currency });
  }
  return candidates.sort((a,b)=>b.expectedNet-a.expectedNet);
}
