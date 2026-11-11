import { gunzipSync } from 'node:zlib';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const STAKES = [1, 2, 3, 5];
export const WINDOWS = [50, 100, 250, 500, 1000, 2500, 5000];
export const STRATEGIES = ['DIFFERS', 'MATCHES', 'EVEN', 'ODD'];
export const SESSION_STOP_LOSS = 10;
const MIN_PARITY_EDGE = 0.55;

export function wilsonInterval(wins, total, z = 1.96) {
  if (!total) return { lower: null, upper: null };
  const p = wins / total, z2 = z * z, denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function chooseByFrequency(counts, digits, mode) {
  const target = mode === 'least' ? Math.min(...counts) : Math.max(...counts);
  const tied = new Set(counts.map((n, i) => n === target ? i : -1).filter(i => i >= 0));
  // Deterministic recency tie-break: the most recently observed tied digit.
  for (let i = digits.length - 1; i >= 0; i--) if (tied.has(digits[i])) return digits[i];
  return 0;
}

function signal(digits, index, windowSize, strategy) {
  const prior = digits.slice(index - windowSize, index);
  if (prior.length !== windowSize) return null;
  if (strategy === 'EVEN' || strategy === 'ODD') {
    const evens = prior.reduce((n, d) => n + (d % 2 === 0 ? 1 : 0), 0);
    const share = strategy === 'EVEN' ? evens / windowSize : (windowSize - evens) / windowSize;
    // Only enter parity contracts when the rolling window shows a directional
    // imbalance; otherwise no trade. The 55% threshold is fixed before testing.
    if (share < MIN_PARITY_EDGE) return null;
    return { barrier: null, expected: strategy === 'EVEN' ? 0 : 1 };
  }
  const counts = Array(10).fill(0);
  for (const digit of prior) counts[digit]++;
  return { barrier: chooseByFrequency(counts, prior, strategy === 'DIFFERS' ? 'least' : 'most') };
}

function outcome(digit, strategy, target) {
  if (strategy === 'DIFFERS') return digit !== target;
  if (strategy === 'MATCHES') return digit === target;
  return strategy === 'EVEN' ? digit % 2 === 0 : digit % 2 === 1;
}

export function parsePayoutSnapshots(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(parsed)) throw new Error('Payout snapshot file must contain a JSON array.');
  const map = new Map();
  for (const q of parsed) {
    const stake = Number(q.stake), payout = Number(q.payout), askPrice = Number(q.askPrice);
    if (!q.symbol || !STRATEGIES.includes(q.contractType) || !Number.isFinite(stake) || stake <= 0 ||
        !Number.isFinite(payout) || payout <= stake || !Number.isFinite(askPrice) || askPrice <= 0) continue;
    if (Math.abs(askPrice - stake) > Math.max(0.01, stake * 0.02)) continue;
    const barrier = q.barrier == null ? '-' : String(q.barrier);
    const key = [q.symbol, q.contractType, barrier, stake].join('|');
    const capturedAt = Date.parse(q.capturedAt || '');
    const previous = map.get(key);
    if (!previous || (Number.isFinite(capturedAt) && capturedAt > previous.capturedAtMs)) {
      map.set(key, { ...q, stake, payout, askPrice, capturedAtMs: Number.isFinite(capturedAt) ? capturedAt : 0 });
    }
  }
  return map;
}

function payoutFor(map, symbol, strategy, barrier, stake) {
  if (!map) return null;
  return map.get([symbol, strategy, barrier == null ? '-' : String(barrier), stake].join('|')) || null;
}

function scoreRange(digits, start, end, symbol, strategy, windowSize, stake, payoutMap) {
  let trades = 0, wins = 0, losses = 0, skipped = 0, lossStreak = 0, maxLossStreak = 0;
  let pnl = 0, maxDrawdown = 0, peak = 0, stopHit = false, stopAt = null;
  let quoteMissing = 0, assumedPnl = null, breakEven = null, quoteCapturedAt = null;
  for (let i = Math.max(start, windowSize); i < end; i++) {
    const pick = signal(digits, i, windowSize, strategy);
    if (!pick) { skipped++; continue; }
    const won = outcome(digits[i], strategy, pick.barrier);
    const quote = payoutFor(payoutMap, symbol, strategy, pick.barrier, stake);
    if (payoutMap && !quote) { quoteMissing++; continue; }
    trades++;
    if (won) { wins++; lossStreak = 0; }
    else { losses++; lossStreak++; maxLossStreak = Math.max(maxLossStreak, lossStreak); }
    if (quote) {
      const delta = won ? quote.payout - stake : -stake;
      pnl += delta;
      peak = Math.max(peak, pnl);
      maxDrawdown = Math.max(maxDrawdown, peak - pnl);
      breakEven = stake / quote.payout;
      quoteCapturedAt = quote.capturedAt || null;
      if (!stopHit && pnl <= -SESSION_STOP_LOSS) { stopHit = true; stopAt = trades; }
    }
  }
  const ci = wilsonInterval(wins, trades);
  const baseline = strategy === 'DIFFERS' ? 0.9 : strategy === 'MATCHES' ? 0.1 : 0.5;
  const payoutPresent = !!payoutMap && quoteMissing === 0 && trades > 0;
  const evPerTrade = payoutPresent ? pnl / trades : null;
  const evPerStake = payoutPresent ? evPerTrade / stake : null;
  const expectedValueUsingObservedRate = payoutPresent ? (wins / trades) * (payoutFor(payoutMap, symbol, strategy,
    strategy === 'DIFFERS' || strategy === 'MATCHES' ? null : null, stake)?.payout || 0) - stake : null;
  return {
    symbol, strategy, windowSize, stake, startIndex: start, endIndex: end,
    trades, wins, losses, skipped, quoteMissing, winRate: trades ? wins / trades : null,
    ci95Lower: ci.lower, ci95Upper: ci.upper, baseline,
    maxConsecutiveLosses: maxLossStreak,
    payoutCoverage: payoutMap ? (trades + quoteMissing ? trades / (trades + quoteMissing) : 0) : null,
    payoutAssumption: payoutPresent ? 'Constant captured proposal payout applied to historical outcomes; not historical realised P/L.' : null,
    currency: payoutPresent ? (payoutFor(payoutMap, symbol, strategy, null, stake)?.currency || null) : null,
    payoutCapturedAt: quoteCapturedAt,
    breakEvenWinProbability: breakEven,
    projectedNetPnl: payoutPresent ? pnl : null,
    projectedEvPerTrade: evPerTrade,
    projectedEvPerStake: evPerStake,
    maxDrawdown: payoutPresent ? maxDrawdown : null,
    sessionStopHit: payoutPresent ? stopHit : null,
    tradesUntilStop: payoutPresent ? stopAt : null,
    expectedValueUsingObservedRate,
    eligible: payoutPresent ? (ci.lower > breakEven && evPerTrade > 0) : false,
  };
}

export function evaluateSymbol(digits, symbol, payoutMap = null) {
  if (!Array.isArray(digits) || digits.some(d => !Number.isInteger(d) || d < 0 || d > 9)) {
    throw new Error('Digits must be an ordered array of integers 0..9.');
  }
  const n = digits.length;
  const trainEnd = Math.floor(n * 0.60);
  const validationEnd = Math.floor(n * 0.80);
  const results = [];
  for (const strategy of STRATEGIES) for (const windowSize of WINDOWS) for (const stake of STAKES) {
    if (trainEnd < windowSize + 100 || validationEnd <= trainEnd || n <= validationEnd) continue;
    const validation = scoreRange(digits, trainEnd, validationEnd, symbol, strategy, windowSize, stake, payoutMap);
    const holdout = scoreRange(digits, validationEnd, n, symbol, strategy, windowSize, stake, payoutMap);
    results.push({ ...validation, split: 'validation', holdout });
  }
  // Rank only on validation. Holdout is reported independently and never used
  // to choose a configuration.
  results.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.projectedEvPerTrade != null && b.projectedEvPerTrade != null) return b.projectedEvPerTrade - a.projectedEvPerTrade;
    if (a.projectedEvPerTrade != null) return -1;
    if (b.projectedEvPerTrade != null) return 1;
    return (b.ci95Lower ?? -1) - (a.ci95Lower ?? -1);
  });
  return {
    symbol, ticks: n, trainEnd, validationEnd,
    rankingBasis: payoutMap ? 'validation payout-adjusted scenario EV; constant quote assumption' : 'validation hit-rate diagnostics only; no profitability ranking',
    results,
  };
}

export async function loadArchives(directory) {
  const names = (await readdir(directory)).filter(n => /^ticks-\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(n)).sort();
  const bySymbol = new Map();
  for (const name of names) {
    const bytes = await readFile(join(directory, name));
    const text = gunzipSync(bytes).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row.symbol || !Number.isSafeInteger(Number(row.epoch)) || !Number.isInteger(Number(row.digit)) || row.digit < 0 || row.digit > 9) continue;
      if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
      bySymbol.get(row.symbol).push({ epoch: Number(row.epoch), digit: Number(row.digit), tickUid: String(row.tick_uid || '') });
    }
  }
  for (const [symbol, rows] of bySymbol) {
    rows.sort((a, b) => a.epoch - b.epoch);
    const seen = new Set();
    const unique = rows.filter(row => {
      if (!row.tickUid) return true;
      const key = symbol + '|' + row.tickUid;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    bySymbol.set(symbol, unique.map(row => row.digit));
  }
  return bySymbol;
}
