export type BacktestStrategy = 'DIFFERS' | 'MATCHES' | 'EVEN' | 'ODD';

export type WalkForwardBacktestResult = {
  strategy: BacktestStrategy;
  windowSize: number;
  totalTicks: number;
  warmupTicks: number;
  testTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  theoreticalBaseline: number;
  differenceFromBaseline: number | null;
  maxConsecutiveLosses: number;
  note: string;
};

/**
 * Chronological, one-step-ahead walk-forward replay.
 * At index i, the decision uses only digits [i-windowSize, i), then scores
 * against digit[i]. No future tick enters the decision window.
 *
 * This reports hit-rate diagnostics only. It intentionally does not invent
 * historical payouts, transaction prices, or P/L.
 */
export function runWalkForwardBacktest(
  inputDigits: number[],
  strategy: BacktestStrategy,
  windowSize: number,
  trainingFraction = 0.7,
): WalkForwardBacktestResult {
  if (!Array.isArray(inputDigits) || inputDigits.some(digit => !Number.isInteger(digit) || digit < 0 || digit > 9)) {
    throw new Error('Backtest requires an ordered array of integer digits from 0 to 9.');
  }
  if (!Number.isInteger(windowSize) || windowSize < 10 || windowSize > 5000) {
    throw new Error('Backtest window must be an integer between 10 and 5,000 ticks.');
  }
  if (!Number.isFinite(trainingFraction) || trainingFraction < 0.5 || trainingFraction >= 0.95) {
    throw new Error('Training fraction must be between 0.50 and 0.95.');
  }
  const theoreticalBaseline = strategy === 'DIFFERS' ? 0.9 : strategy === 'MATCHES' ? 0.1 : 0.5;
  const splitIndex = Math.max(windowSize, Math.floor(inputDigits.length * trainingFraction));
  let wins = 0;
  let losses = 0;
  let currentLossStreak = 0;
  let maxConsecutiveLosses = 0;

  for (let i = splitIndex; i < inputDigits.length; i += 1) {
    const window = inputDigits.slice(i - windowSize, i);
    const counts = Array<number>(10).fill(0);
    for (const digit of window) counts[digit] += 1;
    const leastFrequent = counts.indexOf(Math.min(...counts));
    const mostFrequent = counts.indexOf(Math.max(...counts));
    const actual = inputDigits[i];
    const correct = strategy === 'DIFFERS'
      ? actual !== leastFrequent
      : strategy === 'MATCHES'
        ? actual === mostFrequent
        : strategy === 'EVEN'
          ? actual % 2 === 0
          : actual % 2 === 1;
    if (correct) {
      wins += 1;
      currentLossStreak = 0;
    } else {
      losses += 1;
      currentLossStreak += 1;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentLossStreak);
    }
  }

  const testTrades = wins + losses;
  return {
    strategy,
    windowSize,
    totalTicks: inputDigits.length,
    warmupTicks: splitIndex,
    testTrades,
    wins,
    losses,
    winRate: testTrades ? wins / testTrades : null,
    theoreticalBaseline,
    differenceFromBaseline: testTrades ? wins / testTrades - theoreticalBaseline : null,
    maxConsecutiveLosses,
    note: 'Walk-forward hit rate only. Overlapping windows are dependent observations; this is not proof of statistical significance or profitability. Historical contract payouts and P/L are not reconstructed.',
  };
}
