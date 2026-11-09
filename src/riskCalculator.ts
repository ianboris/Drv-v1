/**
 * Pure risk and contract-economics helpers.
 *
 * These functions support research and pre-trade validation. They do not
 * authorize or execute orders. Minimum stake must come from a current,
 * contract-specific Deriv proposal/validation response, never a hard-coded
 * universal constant.
 */
export type ContractEconomicsInput = {
  /** Amount paid to open the contract. */
  stake: number;
  /** Total payout returned on a win, including the returned stake. */
  payout: number;
  /** Probability estimate measured on held-out observations, in [0, 1]. */
  estimatedWinProbability: number;
};

export type ContractEconomics = {
  netProfitIfWin: number;
  netLossIfLose: number;
  breakEvenWinProbability: number;
  expectedValue: number;
};

export function calculateContractEconomics(input: ContractEconomicsInput): ContractEconomics {
  const { stake, payout, estimatedWinProbability } = input;
  if (!Number.isFinite(stake) || stake <= 0) throw new Error('Stake must be a positive finite number.');
  if (!Number.isFinite(payout) || payout <= stake) throw new Error('Payout must exceed the stake.');
  if (!Number.isFinite(estimatedWinProbability) || estimatedWinProbability < 0 || estimatedWinProbability > 1) {
    throw new Error('Estimated win probability must be between 0 and 1.');
  }
  return {
    netProfitIfWin: payout - stake,
    netLossIfLose: stake,
    breakEvenWinProbability: stake / payout,
    expectedValue: estimatedWinProbability * payout - stake,
  };
}

export type StakeValidationInput = {
  stake: number;
  availableBalance: number;
  /** Must be sourced from a current contract-specific Deriv response. */
  verifiedMinimumStake?: number | null;
  /** Optional contract-specific maximum, when supplied by Deriv. */
  verifiedMaximumStake?: number | null;
};

export function validateContractStake(input: StakeValidationInput): { valid: boolean; reason: string | null } {
  const { stake, availableBalance, verifiedMinimumStake, verifiedMaximumStake } = input;
  if (!Number.isFinite(stake) || stake <= 0) return { valid: false, reason: 'Stake must be positive.' };
  if (!Number.isFinite(availableBalance) || availableBalance < 0) return { valid: false, reason: 'Available balance is invalid.' };
  if (verifiedMinimumStake != null && (!Number.isFinite(verifiedMinimumStake) || verifiedMinimumStake <= 0)) {
    return { valid: false, reason: 'Verified contract minimum is invalid.' };
  }
  if (verifiedMaximumStake != null && (!Number.isFinite(verifiedMaximumStake) || verifiedMaximumStake <= 0)) {
    return { valid: false, reason: 'Verified contract maximum is invalid.' };
  }
  if (verifiedMinimumStake != null && stake < verifiedMinimumStake) {
    return { valid: false, reason: 'Stake is below the verified contract minimum.' };
  }
  if (verifiedMaximumStake != null && stake > verifiedMaximumStake) {
    return { valid: false, reason: 'Stake exceeds the verified contract maximum.' };
  }
  if (stake > availableBalance) return { valid: false, reason: 'Stake exceeds available balance.' };
  return { valid: true, reason: null };
}

export function evaluateSessionLimit(input: {
  realizedSessionPnl: number;
  stopLoss: number;
  takeProfit: number;
}): { locked: boolean; reason: 'STOP_LOSS' | 'TAKE_PROFIT' | null } {
  const { realizedSessionPnl, stopLoss, takeProfit } = input;
  if (![realizedSessionPnl, stopLoss, takeProfit].every(Number.isFinite) || stopLoss <= 0 || takeProfit <= 0) {
    throw new Error('Session P/L and positive stop limits must be finite numbers.');
  }
  if (realizedSessionPnl <= -stopLoss) return { locked: true, reason: 'STOP_LOSS' };
  if (realizedSessionPnl >= takeProfit) return { locked: true, reason: 'TAKE_PROFIT' };
  return { locked: false, reason: null };
}
