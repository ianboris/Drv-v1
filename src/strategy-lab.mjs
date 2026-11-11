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
  // Deterministic recency tie-break: most recently observed tied digit.
  for (let i = digits.length - 1; i >= 0; i--) if (tied.has(digits[i])) return digits[i];
  return 0;
}

function signal(digits, index, windowSize, strategy) {
  const prior = digits.slice(index - windowSize, index);
  if (prior.length !== windowSize) return null;
  if (strategy === 'EVEN' || strategy === 'ODD') {
    const evens = prior.reduce((n, d) => n + (d % 2 === 0 ? 1 : 0), 0);
    const share = strategy === 'EVEN' ? evens / windowSize : (windowSize - evens) / windowSize;
    // Fixed 55% directional filter; parity contracts are not entered without it.
    if (share < MIN_PARITY_EDGE) return null;
    return { barrier: null };
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
  let signals = 0, trades = 0, wins = 0, losses = 0, skipped = 0, lossStreak = 0, maxLossStreak = 0;
  let scenarioPnl = 0, peak = 0, maxDrawdown = 0, stopHit = false, stopAt = null;
  let quoteMissing = 0, maxBreakEven = 0, minCapturedAt = Infinity, maxCapturedAt = 0, grossPayoutSum = 0;
  for (let i = Math.max(start, windowSize); i < end; i++) {
    const pick = signal(digits, i, windowSize, strategy);
    if (!pick) { skipped++; continue; }
    signals++;
    const quote = payoutFor(payoutMap, symbol, strategy, pick.barrier, stake);
    if (payoutMap && !quote) { quoteMissing++; skipped++; continue; }
    if (stopHit) { skipped++; continue; }
    const won = outcome(digits[i], strategy, pick.barrier);
    trades++;
    if (won) { wins++; lossStreak = 0; }
    else { losses++; lossStreak++; maxLossStreak = Math.max(maxLossStreak, lossStreak); }
    if (quote) {
      const breakEven = stake / quote.payout;
      maxBreakEven = Math.max(maxBreakEven, breakEven);
      grossPayoutSum += quote.payout;
      if (quote.capturedAtMs) {
        minCapturedAt = Math.min(minCapturedAt, quote.capturedAtMs);
        maxCapturedAt = Math.max(maxCapturedAt, quote.capturedAtMs);
      }
      scenarioPnl += won ? quote.payout - stake : -stake;
      peak = Math.max(peak, scenarioPnl);
      maxDrawdown = Math.max(maxDrawdown, peak - scenarioPnl);
      if (scenarioPnl <= -SESSION_STOP_LOSS) { stopHit = true; stopAt = trades; }
    }
  }
  const ci = wilsonInterval(wins, trades);
  const baseline = strategy === 'DIFFERS' ? 0.9 : strategy === 'MATCHES' ? 0.1 : 0.5;
  const quoteCoverage = signals ? (signals - quoteMissing) / signals : null;
  const payoutComplete = !!payoutMap && quoteMissing === 0 && trades > 0;
  const scenarioNetPerTrade = payoutComplete ? scenarioPnl / trades : null;
  return {
    symbol, strategy, windowSize, stake, startIndex: start, endIndex: end,
    signals, trades, wins, losses, skipped, quoteMissing,
    winRate: trades ? wins / trades : null,
    ci95Lower: ci.lower, ci95Upper: ci.upper, theoreticalBaseline: baseline,
    maxConsecutiveLosses: maxLossStreak, quoteCoverage,
    payoutAssumption: payoutComplete ? 'Captured proposal payouts held constant in historical replay; not historical realised P/L.' : null,
    currency: payoutComplete ? (payoutFor(payoutMap, symbol, strategy, strategy === 'DIFFERS' || strategy === 'MATCHES' ? 0 : null, stake)?.currency || null) : null,
    payoutCapturedAtRange: payoutComplete && minCapturedAt !== Infinity ? [new Date(minCapturedAt).toISOString(), new Date(maxCapturedAt).toISOString()] : null,
    conservativeBreakEvenWinProbability: payoutComplete ? maxBreakEven : null,
    scenarioNetPnl: payoutComplete ? scenarioPnl : null,
    scenarioNetPerTrade,
    averageGrossPayout: payoutComplete ? grossPayoutSum / trades : null,
    maxDrawdown: payoutComplete ? maxDrawdown : null,
    sessionStopHit: payoutComplete ? stopHit : null,
    tradesUntilStop: payoutComplete ? stopAt : null,
    eligible: payoutComplete && ci.lower > maxBreakEven && scenarioNetPerTrade > 0,
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
  // Ranking uses validation only. The final 20% holdout is never used to select.
  results.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.scenarioNetPerTrade != null && b.scenarioNetPerTrade != null) return b.scenarioNetPerTrade - a.scenarioNetPerTrade;
    if (a.scenarioNetPerTrade != null) return -1;
    if (b.scenarioNetPerTrade != null) return 1;
    return (b.ci95Lower ?? -1) - (a.ci95Lower ?? -1);
  });
  return {
    symbol, ticks: n, trainEnd, validationEnd,
    rankingBasis: payoutMap ? 'validation replay using exact captured quotes; constant-payout scenario only' : 'validation hit-rate diagnostics only; no monetary profitability ranking',
    results,
  };
}

export async function loadArchives(directory) {
  const names = (await readdir(directory)).filter(n => /^ticks-\\d{4}-\\d{2}-\\d{2}\\.jsonl\\.gz$/.test(n)).sort();
  const bySymbol = new Map();
  for (const name of names) {
    const bytes = await readFile(join(directory, name));
    const text = gunzipSync(bytes).toString('utf8');
    for (const line of text.split('\\n')) {
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
