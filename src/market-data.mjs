export function normalizePipSize(value, quote) {
  if (value !== undefined && value !== null) {
    const pipSize = Number(value);
    if (Number.isFinite(pipSize) && pipSize >= 0) {
      // Older responses may express precision as an integer decimal count (e.g. 2).
      if (Number.isInteger(pipSize) && pipSize <= 10) return pipSize;
      // Current Deriv responses may express pip_size as the minimum price increment
      // (e.g. 0.01). Convert that increment to the equivalent decimal-place count.
      if (pipSize > 0 && pipSize < 1) {
        const normalized = pipSize.toFixed(10).replace(/0+$/, '');
        const decimals = normalized.includes('.') ? normalized.split('.')[1].length : 0;
        if (decimals >= 0 && decimals <= 10) return decimals;
      }
    }
  }

  if (quote !== undefined && quote !== null && Number.isFinite(Number(quote))) {
    const normalized = Number(quote).toFixed(10).replace(/0+$/, '');
    const decimals = normalized.includes('.') ? normalized.split('.')[1].length : 0;
    return Math.min(10, Math.max(0, decimals));
  }
  return undefined;
}

export function digitFromQuote(quote, pipSize) {
  if (!Number.isFinite(Number(quote))) return 0;
  const decimals = normalizePipSize(pipSize, Number(quote)) ?? 0;
  const fixed = Number(quote).toFixed(decimals);
  return Number((fixed.split('.')[1] || fixed).slice(-1) || 0);
}
