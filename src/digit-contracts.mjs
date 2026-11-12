const CONTRACT_TYPES = Object.freeze({
  DIFFERS: 'DIGITDIFF',
  MATCHES: 'DIGITMATCH',
  EVEN: 'DIGITEVEN',
  ODD: 'DIGITODD',
});

/**
 * Build the exact one-tick Deriv proposal payload for a digit strategy.
 * Parity contracts do not use a digit barrier; Matches/Differs require one.
 */
export function createDigitProposalRequest({ strategy, symbol, amount, currency, targetDigit, reqId }) {
  const contractType = CONTRACT_TYPES[strategy];
  if (!contractType) throw new Error('Unsupported digit strategy.');
  if (typeof symbol !== 'string' || !symbol.trim()) throw new Error('A market symbol is required.');
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Stake must be positive.');
  if (typeof currency !== 'string' || !currency.trim()) throw new Error('Account currency is required.');
  if (!Number.isSafeInteger(reqId) || reqId <= 0) throw new Error('A positive request ID is required.');
  const payload = {
    proposal: 1,
    amount,
    basis: 'stake',
    contract_type: contractType,
    currency,
    duration: 1,
    duration_unit: 't',
    underlying_symbol: symbol,
    subscribe: 1,
    req_id: reqId,
  };
  if (strategy === 'DIFFERS' || strategy === 'MATCHES') {
    if (!Number.isInteger(targetDigit) || targetDigit < 0 || targetDigit > 9) {
      throw new Error('Matches and Differs require a target digit from 0 to 9.');
    }
    payload.barrier = String(targetDigit);
  }
  return payload;
}
