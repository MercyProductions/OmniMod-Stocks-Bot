/** Parse the per-side slippage assumption used by the stock paper backtest. */
export function parseAssumedSlippageBps(value, fallback = 8) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new RangeError('slippageBps must be a finite value from 0 to 100 per side.');
  }
  return parsed;
}

/** Pass the exact replay cost assumptions and provenance through to prediction grading. */
export function predictionCostSettings(settings, selectedCosts, observedSpreadBps) {
  const appliedSlippageBpsPerSide = Math.max(Number(selectedCosts?.slippageBpsPerSide ?? settings.assumedSlippageBps), Number(observedSpreadBps || 0) / 2);
  return {
    ...settings,
    assumedSlippageBps: selectedCosts?.slippageBpsPerSide ?? settings.assumedSlippageBps,
    commissionBpsPerSide: selectedCosts?.feeBpsPerSide ?? 0,
    executionCostContext: selectedCosts ? { ...selectedCosts, appliedSlippageBpsPerSide } : null,
    allowRuleOnlySignals: true,
  };
}
