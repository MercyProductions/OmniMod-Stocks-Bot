import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaperResearchContext } from '../paperResearchContext.js';

test('research context preserves bounded issuance-time features and distinguishes unknown regimes', () => {
  const quote = '2026-09-29T15:00:00.000Z';
  const row = normalizePaperResearchContext({ setupType: 'Opening Range Breakout',
    marketRegime: 'Risk-On Trend', regimeSource: 'SPY breadth', observedAt: '2026-09-29T14:59:59.000Z',
    features: { atr14: 1.2, relative_volume: '1.8', missing: null, boolean: true, malicious: Infinity } }, quote);
  assert.equal(row.setupType, 'opening_range_breakout');
  assert.equal(row.marketRegime, 'risk-on_trend');
  assert.equal(row.volatilityRegime, 'unknown');
  assert.equal(row.regimeSource, 'spy_breadth');
  assert.deepEqual(row.features, { atr14: 1.2, relative_volume: 1.8 });
  assert.equal(row.observedAt, '2026-09-29T14:59:59.000Z');
});

test('future or malformed research labels cannot masquerade as timestamped evidence', () => {
  const quote = '2026-09-29T15:00:00.000Z';
  const row = normalizePaperResearchContext({ setupType: '<script>', marketRegime: 'bullish now!',
    observedAt: '2026-09-29T15:01:00.000Z', features: { '__proto__': 1, safe: 4 } }, quote);
  assert.equal(row.setupType, 'unknown');
  assert.equal(row.marketRegime, 'unknown');
  assert.equal(row.observedAt, null);
  assert.deepEqual(row.features, { safe: 4 });
  assert.equal(normalizePaperResearchContext(null, quote).status, 'unavailable');
});
