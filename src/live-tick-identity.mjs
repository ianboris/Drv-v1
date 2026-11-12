/**
 * Deriv tick.id identifies a subscription stream, not an individual tick.
 * Use the market timestamp and quote so successive ticks on one subscription
 * are not mistakenly discarded as duplicates.
 */
export function createLiveTickId(symbol, epoch, quote) {
  if (typeof symbol !== 'string' || !symbol) throw new Error('A market symbol is required.');
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('A valid tick epoch is required.');
  if (!Number.isFinite(quote)) throw new Error('A finite tick quote is required.');
  return `live:${symbol}:${epoch}:${quote}`;
}
