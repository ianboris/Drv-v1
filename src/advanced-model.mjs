const DIGIT_COUNT = 10;
const MODELS = ['rolling_dirichlet', 'exponential_decay', 'markov_shrinkage'];
const CONTRACTS = ['DIFFERS', 'MATCHES', 'EVEN', 'ODD'];

function assertDigits(digits) {
  if (!Array.isArray(digits) || digits.some(d => !Number.isInteger(d) || d < 0 || d > 9)) {
    throw new Error('Expected an ordered digit array containing integers from 0 to 9.');
  }
}

function normalizeDistribution(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return Array(DIGIT_COUNT).fill(0.1);
  return values.map(value => value / total);
}

function rollingDistribution(history, windowSize) {
  const sample = history.slice(-windowSize);
  const counts = Array(DIGIT_COUNT).fill(0.5); // Jeffreys smoothing
  for (const digit of sample) counts[digit]++;
  return normalizeDistribution(counts);
}

function decayDistribution(history, windowSize) {
  const sample = history.slice(-windowSize);
  const halfLife = Math.max(10, windowSize / 4);
  const counts = Array(DIGIT_COUNT).fill(0.5);
  for (let i = 0; i < sample.length; i++) {
    const age = sample.length - 1 - i;
    counts[sample[i]] += Math.pow(0.5, age / halfLife);
  }
  return normalizeDistribution(counts);
}

function markovDistribution(history, windowSize) {
  const sample = history.slice(-windowSize);
  const prior = rollingDistribution(sample, Math.max(1, sample.length));
  const previous = sample.at(-1);
  if (previous === undefined) return prior;
  const transitions = Array(DIGIT_COUNT).fill(0);
  let transitionCount = 0;
  for (let i = 1; i < sample.length; i++) {
    if (sample[i - 1] === previous) {
      transitions[sample[i]]++;
      transitionCount++;
    }
  }
  const shrinkage = 20;
  return normalizeDistribution(transitions.map((count, digit) => count + shrinkage * prior[digit]));
}

export function forecastDigitProbabilities(history, windowSize, model = 'rolling_dirichlet') {
  assertDigits(history);
  if (!Number.isInteger(windowSize) || windowSize < 1) throw new Error('windowSize must be a positive integer.');
  if (!MODELS.includes(model)) throw new Error('Unknown forecast model.');
  if (history.length < windowSize) throw new Error('Not enough history for the requested window.');
  if (model === 'rolling_dirichlet') return rollingDistribution(history, windowSize);
  if (model === 'exponential_decay') return decayDistribution(history, windowSize);
  return markovDistribution(history, windowSize);
}

export function logLoss(probabilities, actualDigit) {
  if (!Array.isArray(probabilities) || probabilities.length !== DIGIT_COUNT ||
      probabilities.some(p => !Number.isFinite(p) || p < 0 || p > 1) ||
      !Number.isInteger(actualDigit) || actualDigit < 0 || actualDigit > 9) {
    throw new Error('Invalid probability vector or observed digit.');
  }
  return -Math.log(Math.max(1e-12, probabilities[actualDigit]));
}

function candidateContracts(probabilities, symbol, stake, payoutMap, currency) {
  if (!payoutMap) return [];
  const candidates = [];
  const parityProbabilities = {
    EVEN: probabilities.filter((_, digit) => digit % 2 === 0).reduce((a, b) => a + b, 0),
    ODD: probabilities.filter((_, digit) => digit % 2 === 1).reduce((a, b) => a + b, 0),
  };
  for (const contract of CONTRACTS) {
    const barriers = contract === 'DIFFERS' || contract === 'MATCHES' ? Array.from({ length: 10 }, (_, i) => String(i)) : [null];
    for (const barrier of barriers) {
      const key = [symbol, contract, barrier == null ? '-' : barrier, stake].join('|');
      const quote = payoutMap.get(key);
      if (!quote || String(quote.currency || '').toUpperCase() !== currency) continue;
      const pWin = contract === 'DIFFERS'
        ? 1 - probabilities[Number(barrier)]
        : contract === 'MATCHES'
          ? probabilities[Number(barrier)]
          : parityProbabilities[contract];
      const cost = Number(quote.askPrice);
      const grossPayout = Number(quote.payout);
      if (!(cost > 0) || !(grossPayout > cost) || !(pWin >= 0 && pWin <= 1)) continue;
      const expectedNet = pWin * grossPayout - cost;
      candidates.push({
        contract, barrier, pWin, askPrice: cost, grossPayout,
        expectedNet, expectedReturnOnStake: expectedNet / stake,
        breakEvenProbability: cost / grossPayout,
        currency,
      });
    }
  }
  return candidates.sort((a, b) => b.expectedNet - a.expectedNet);
}

function simulateSegment(digits, start, end, symbol, windowSize, model, stake, payoutMap, currency) {
  let trades = 0, wins = 0, losses = 0, skipped = 0;
  let pnl = 0, peak = 0, maxDrawdown = 0, stopHit = false, tradesUntilStop = null;
  let maxLossStreak = 0, lossStreak = 0, totalExpectedNet = 0;
  const chosenContracts = {};
  for (let i = start; i < end; i++) {
    if (stopHit) { skipped++; continue; }
    const history = digits.slice(Math.max(0, i - windowSize), i);
    if (history.length < windowSize) { skipped++; continue; }
    const probabilities = forecastDigitProbabilities(history, windowSize, model);
    const candidates = candidateContracts(probabilities, symbol, stake, payoutMap, currency);
    const selected = candidates[0];
    if (!selected || selected.expectedNet <= 0) { skipped++; continue; }
    trades++;
    chosenContracts[selected.contract] = (chosenContracts[selected.contract] || 0) + 1;
    const digit = digits[i];
    const won = selected.contract === 'DIFFERS' ? digit !== Number(selected.barrier)
      : selected.contract === 'MATCHES' ? digit === Number(selected.barrier)
        : selected.contract === 'EVEN' ? digit % 2 === 0 : digit % 2 === 1;
    if (won) {
      wins++;
      lossStreak = 0;
      pnl += selected.grossPayout - selected.askPrice;
    } else {
      losses++;
      lossStreak++;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
      pnl -= selected.askPrice;
    }
    totalExpectedNet += selected.expectedNet;
    peak = Math.max(peak, pnl);
    maxDrawdown = Math.max(maxDrawdown, peak - pnl);
    if (pnl <= -10) { stopHit = true; tradesUntilStop = trades; }
  }
  return {
    startIndex: start, endIndex: end, trades, wins, losses, skipped,
    winRate: trades ? wins / trades : null,
    scenarioNetPnl: trades ? pnl : null,
    scenarioNetPerTrade: trades ? pnl / trades : null,
    meanForecastExpectedNet: trades ? totalExpectedNet / trades : null,
    maxDrawdown: trades ? maxDrawdown : null,
    maxConsecutiveLosses: maxLossStreak,
    sessionStopHit: stopHit,
    tradesUntilStop,
    selectedContractCounts: chosenContracts,
    payoutScenario: 'Captured USD proposal payouts held constant; not historical realised P/L.',
  };
}

function scoreForecastModel(digits, start, end, windowSize, model) {
  let loss = 0, count = 0, brier = 0;
  for (let i = start; i < end; i++) {
    const history = digits.slice(Math.max(0, i - windowSize), i);
    if (history.length < windowSize) continue;
    const probabilities = forecastDigitProbabilities(history, windowSize, model);
    loss += logLoss(probabilities, digits[i]);
    for (let d = 0; d < DIGIT_COUNT; d++) {
      const error = probabilities[d] - (digits[i] === d ? 1 : 0);
      brier += error * error;
    }
    count++;
  }
  return { model, observations: count, meanLogLoss: count ? loss / count : null, meanBrierScore: count ? brier / count : null };
}

export function evaluateAdvancedModel(digits, symbol, payoutMap, { currency = 'USD', stakes = [1, 2, 3, 5], windows = [50, 100, 250, 500, 1000, 2500, 5000] } = {}) {
  assertDigits(digits);
  const normalizedCurrency = String(currency).toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(normalizedCurrency)) throw new Error('A valid account currency is required.');
  const n = digits.length;
  const warmupEnd = Math.floor(n * 0.6);
  const validationEnd = Math.floor(n * 0.8);
  const results = [];
  for (const windowSize of windows) {
    if (warmupEnd < windowSize + 100 || validationEnd <= warmupEnd || n <= validationEnd) continue;
    const modelScores = MODELS.map(model => scoreForecastModel(digits, warmupEnd, validationEnd, windowSize, model));
    const rankedModels = modelScores.filter(s => s.meanLogLoss !== null).sort((a, b) => a.meanLogLoss - b.meanLogLoss);
    const selectedModel = rankedModels[0]?.model || null;
    if (!selectedModel) continue;
    for (const stake of stakes) {
      const validation = simulateSegment(digits, warmupEnd, validationEnd, symbol, windowSize, selectedModel, stake, payoutMap, normalizedCurrency);
      const holdout = simulateSegment(digits, validationEnd, n, symbol, windowSize, selectedModel, stake, payoutMap, normalizedCurrency);
      results.push({
        symbol, currency: normalizedCurrency, windowSize, stake,
        selectedModel, modelSelectionMetric: 'validation mean multiclass log loss',
        validationModelScores: modelScores,
        validation, holdout,
        preliminaryScreenPass: validation.trades >= 100 && validation.scenarioNetPnl > 0 &&
          validation.scenarioNetPerTrade > 0,
      });
    }
  }
  results.sort((a, b) => {
    if (a.preliminaryScreenPass !== b.preliminaryScreenPass) return a.preliminaryScreenPass ? -1 : 1;
    return (b.validation.scenarioNetPerTrade ?? -Infinity) - (a.validation.scenarioNetPerTrade ?? -Infinity);
  });
  return {
    symbol, currency: normalizedCurrency, ticks: n, warmupEnd, validationEnd,
    modelFamily: 'Bayesian-smoothed rolling, exponential-decay and first-order Markov predictive distributions',
    selectionRule: 'Select the forecast model by validation log loss; holdout is not used to choose the model. Contract choice maximizes payout-adjusted expected net return at each tick.',
    riskRule: 'One sequential one-tick position at a time; stop opening new positions once cumulative session P/L is at or below -10 account-currency units.',
    results,
  };
}
