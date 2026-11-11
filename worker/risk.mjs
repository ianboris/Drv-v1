export function wilsonLowerBound(wins, total, z = 1.959963984540054) {
  if (!Number.isInteger(wins) || !Number.isInteger(total) || total <= 0 || wins < 0 || wins > total) return null;
  const p = wins / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return (centre - margin) / denominator;
}

export function payoutAdjustedEv(winProbability, grossPayout, stake) {
  if (![winProbability, grossPayout, stake].every(Number.isFinite) ||
      winProbability < 0 || winProbability > 1 || grossPayout <= 0 || stake <= 0) {
    throw new Error("Invalid EV inputs.");
  }
  return winProbability * grossPayout - stake;
}

export function assertRiskAllowed({
  stopRequested, buyUnknown, workerEpoch, currentEpoch, inFlightOrderUid,
  orderUid, balance, stake, maxStakePct, dailyNetPl, dailyLossLimit,
  consecutiveLosses, consecutiveLossLimit, mode, plumbingRemaining,
}) {
  if (stopRequested) throw new Error("STOP_REQUESTED");
  if (buyUnknown) throw new Error("BUY_UNKNOWN_REQUIRES_RECONCILIATION");
  if (!Number.isInteger(workerEpoch) || workerEpoch !== currentEpoch) throw new Error("STALE_WORKER_EPOCH");
  if (inFlightOrderUid && inFlightOrderUid !== orderUid) throw new Error("ORDER_SLOT_OCCUPIED");
  if (!(balance > 0) || !(stake > 0) || !(maxStakePct > 0 && maxStakePct <= 0.05)) throw new Error("INVALID_STAKE_CONFIGURATION");
  if (stake > balance * maxStakePct + 1e-9) throw new Error("STAKE_EXCEEDS_BALANCE_PERCENT_CAP");
  if (!(dailyLossLimit > 0) || dailyNetPl <= -dailyLossLimit) throw new Error("DAILY_LOSS_LIMIT_REACHED");
  if (consecutiveLosses >= consecutiveLossLimit) throw new Error("CONSECUTIVE_LOSS_LIMIT_REACHED");
  if (mode === "PLUMBING_TEST" && (!Number.isInteger(plumbingRemaining) || plumbingRemaining <= 0)) throw new Error("PLUMBING_TRADE_CAP_REACHED");
  if (!["DEMO", "PLUMBING_TEST"].includes(mode)) throw new Error("UNSUPPORTED_EXECUTION_MODE");
  return true;
}

export function digitFromQuote(quote, pipSize) {
  if (!Number.isFinite(Number(quote)) || !Number.isInteger(pipSize) || pipSize < 0 || pipSize > 10) {
    throw new Error("Invalid quote precision.");
  }
  const fixed = Number(quote).toFixed(pipSize);
  return Number(fixed.at(-1));
}

export function leastFrequentDigit(digits) {
  if (!Array.isArray(digits) || digits.length < 50 || digits.some((d) => !Number.isInteger(d) || d < 0 || d > 9)) {
    throw new Error("At least 50 valid historical digits are required.");
  }
  const counts = Array(10).fill(0);
  for (const digit of digits) counts[digit] += 1;
  return counts.indexOf(Math.min(...counts));
}
