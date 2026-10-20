export function horizonScenario(row, horizonDays, returnPct, name) {
  const dailySigmaPct = Number(row.volatility20dPct) / Math.sqrt(20);
  const horizonSigmaPct = dailySigmaPct * Math.sqrt(horizonDays);
  const normalizedMove = Number(returnPct) / horizonSigmaPct;
  if (!Number.isFinite(normalizedMove) || !Number.isFinite(Number(row.price)) || Number(row.price) <= 0 || dailySigmaPct <= 0) {
    return { horizon: name, bias: 'UNAVAILABLE', normalizedMove: null, reason: 'Price, return, or volatility input is missing.' };
  }
  const bias = normalizedMove >= 0.35 ? 'UPWARD WATCH' : normalizedMove <= -0.35 ? 'DOWNWARD WATCH' : 'NEUTRAL';
  if (bias === 'NEUTRAL') return { horizon: name, bias, normalizedMove: Number(normalizedMove.toFixed(2)), unitVolatilityMovePct: Number(horizonSigmaPct.toFixed(3)) };
  const direction = bias === 'UPWARD WATCH' ? 1 : -1;
  const entryReference = Number(row.price), unitMove = entryReference * horizonSigmaPct / 100;
  return { horizon: name, bias, normalizedMove: Number(normalizedMove.toFixed(2)), unitVolatilityMovePct: Number(horizonSigmaPct.toFixed(3)),
    entryReference, invalidationScenario: Number((entryReference - direction * unitMove).toFixed(8)),
    target1Scenario: Number((entryReference + direction * unitMove).toFixed(8)),
    target2Scenario: Number((entryReference + direction * unitMove * 2).toFixed(8)),
    note: 'Volatility-scaled reference levels from supplied returns; not predicted prices or calibrated probabilities.' };
}
