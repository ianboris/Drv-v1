import { gunzipSync } from 'node:zlib';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const STAKES = [1, 2, 3, 5];
export const WINDOWS = [50, 100, 250, 500, 1000, 2500, 5000];
export const STRATEGIES = ['DIFFERS', 'MATCHES', 'EVEN', 'ODD'];
export const SESSION_STOP_LOSS = 10;

function normalizeContractType(value) {
  const aliases = { DIGITDIFF: 'DIFFERS', DIGITMATCH: 'MATCHES', DIGITEVEN: 'EVEN', DIGITODD: 'ODD' };
  const normalized = String(value || '').toUpperCase();
  return aliases[normalized] || (STRATEGIES.includes(normalized) ? normalized : null);
}
const MIN_PARITY_EDGE = 0.55;

export function wilsonInterval(wins, total, z = 1.96) {
  if (!total) return { lower: null, upper: null };
  const p = wins / total, z2 = z * z, denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function chooseByFrequency(counts, lastSeen, mode, windowStart) {
  const target = mode === 'least' ? Math.min(...counts) : Math.max(...counts);
  let chosen = 0, latest = -1;
  for (let digit = 0; digit < 10; digit++) {
    if (counts[digit] === target && lastSeen[digit] >= windowStart && lastSeen[digit] > latest) {
      chosen = digit;
      latest = lastSeen[digit];
    }
  }
  return chosen;
}

function buildSignals(digits, windowSize, strategy) {
  const signals = Array(digits.length).fill(null);
  if (digits.length <= windowSize) return signals;
  const counts = Array(10).fill(0);
  const lastSeen = Array(10).fill(-1);
  let evens = 0;
  for (let i = 0; i < windowSize; i++) {
    const digit = digits[i];
    counts[digit]++;
    lastSeen[digit] = i;
    if (digit % 2 === 0) evens++;
  }
  for (let i = windowSize; i < digits.length; i++) {
    if (strategy === 'EVEN' || strategy === 'ODD') {
      const share = strategy === 'EVEN' ? evens / windowSize : (windowSize - evens) / windowSize;
      // Fixed 55% directional filter; parity contracts are not entered without it.
      if (share >= MIN_PARITY_EDGE) signals[i] = { barrier: null };
    } else {
      signals[i] = {
        barrier: chooseByFrequency(counts, lastSeen, strategy === 'DIFFERS' ? 'least' : 'most', i - windowSize),
      };
    }
    const outgoing = digits[i - windowSize];
    counts[outgoing]--;
    if (outgoing % 2 === 0) evens--;
    const incoming = digits[i];
    counts[incoming]++;
    lastSeen[incoming] = i;
    if (incoming % 2 === 0) evens++;
  }
  return signals;
}

function outcome(digit, strategy, target) {
  if (strategy === 'DIFFERS') return digit !== target;
  if (strategy === 'MATCHES') return digit === target;
  return strategy === 'EVEN' ? digit % 2 === 0 : digit % 2 === 1;
}

export function parsePayoutSnapshots(raw) {
  const input = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const parsed = Array.isArray(input) ? input : input?.snapshots;
  if (!Array.isArray(parsed)) throw new Error('Payout snapshot file must contain an array or an object with a snapshots array.');
  const map = new Map();
  for (const q of parsed) {
    const contractType = normalizeContractType(q.contractType ?? q.contract_type);
    const symbol = q.symbol ?? q.underlying_symbol;
    const askPrice = Number(q.askPrice ?? q.ask_price);
    const stake = Number(q.stake ?? q.amount ?? askPrice), payout = Number(q.payout);
    if (!symbol || !contractType || !Number.isFinite(stake) || stake <= 0 ||
        !Number.isFinite(payout) || payout <= stake || !Number.isFinite(askPrice) || askPrice <= 0) continue;
    if (Math.abs(askPrice - stake) > Math.max(0.01, stake * 0.02)) continue;
    const barrier = q.barrier == null ? '-' : String(q.barrier);
    const key = [symbol, contractType, barrier, stake].join('|');
    const capturedAt = Date.parse(q.capturedAt || '');
    const previous = map.get(key);
    if (!previous || (Number.isFinite(capturedAt) && capturedAt > previous.capturedAtMs)) {
      map.set(key, { ...q, symbol, contractType, stake, payout, askPrice, capturedAtMs: Number.isFinite(capturedAt) ? capturedAt : 0 });
    }
  }
  return map;
}

function payoutFor(map, symbol, strategy, barrier, stake) {
  if (!map) return null;
  return map.get([symbol, strategy, barrier == null ? '-' : String(barrier), stake].join('|')) || null;
}

function scoreRange(digits, signalsByIndex, start, end, symbol, strategy, windowSize, stake, payoutMap) {
  let signals = 0, trades = 0, wins = 0, losses = 0, skipped = 0, lossStreak = 0, maxLossStreak = 0;
  let scenarioPnl = 0, peak = 0, maxDrawdown = 0, stopHit = false, stopAt = null;
  let quoteMissing = 0, maxBreakEven = 0, minCapturedAt = Infinity, maxCapturedAt = 0, grossPayoutSum = 0;
  const currencies = new Set();
  for (let i = Math.max(start, windowSize); i < end; i++) {
    const pick = signalsByIndex[i];
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
      if (quote.currency) currencies.add(String(quote.currency));
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
    wilson95LowerDiagnostic: ci.lower, wilson95UpperDiagnostic: ci.upper, theoreticalBaseline: baseline,
    maxConsecutiveLosses: maxLossStreak, quoteCoverage,
    payoutAssumption: payoutComplete ? 'Captured proposal payouts held constant in historical replay; not historical realised P/L.' : null,
    currency: payoutComplete && currencies.size === 1 ? [...currencies][0] : payoutComplete ? 'MIXED_OR_UNSPECIFIED' : null,
    payoutCapturedAtRange: payoutComplete && minCapturedAt !== Infinity ? [new Date(minCapturedAt).toISOString(), new Date(maxCapturedAt).toISOString()] : null,
    conservativeBreakEvenWinProbability: payoutComplete ? maxBreakEven : null,
    scenarioNetPnl: payoutComplete ? scenarioPnl : null,
    scenarioNetPerTrade,
    averageGrossPayout: payoutComplete ? grossPayoutSum / trades : null,
    maxDrawdown: payoutComplete ? maxDrawdown : null,
    sessionStopHit: payoutComplete ? stopHit : null,
    tradesUntilStop: payoutComplete ? stopAt : null,
    preliminaryScreenPass: payoutComplete && ci.lower > maxBreakEven && scenarioNetPerTrade > 0,
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
  for (const strategy of STRATEGIES) for (const windowSize of WINDOWS) {
    if (trainEnd < windowSize + 100 || validationEnd <= trainEnd || n <= validationEnd) continue;
    const signalsByIndex = buildSignals(digits, windowSize, strategy);
    for (const stake of STAKES) {
    const validation = scoreRange(digits, signalsByIndex, trainEnd, validationEnd, symbol, strategy, windowSize, stake, payoutMap);
    const holdout = scoreRange(digits, signalsByIndex, validationEnd, n, symbol, strategy, windowSize, stake, payoutMap);
    results.push({ ...validation, split: 'validation', holdout });
    }
  }
  // Ranking uses validation only. The final 20% holdout is never used to select.
  results.sort((a, b) => {
    if (a.preliminaryScreenPass !== b.preliminaryScreenPass) return a.preliminaryScreenPass ? -1 : 1;
    if (a.scenarioNetPerTrade != null && b.scenarioNetPerTrade != null) return b.scenarioNetPerTrade - a.scenarioNetPerTrade;
    if (a.scenarioNetPerTrade != null) return -1;
    if (b.scenarioNetPerTrade != null) return 1;
    return (b.wilson95LowerDiagnostic ?? -1) - (a.wilson95LowerDiagnostic ?? -1);
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
