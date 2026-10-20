import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEtfCount, formatEtfDiscoverySummary, formatEtfResult, prioritizeEtfAlertRows } from '../src/alertFormat.js';

test('ETF admin summary prints unknown counters as unknown and preserves observed zeroes', () => {
  assert.equal(formatEtfCount(0), '0');
  assert.equal(formatEtfCount(null), 'unknown');
  assert.equal(formatEtfCount(undefined), 'unknown');
  assert.equal(formatEtfCount(2.5), 'unknown');
  assert.equal(formatEtfDiscoverySummary({ mode: 'dynamic-directory-and-screener', universeSize: 0,
    selectedCandidates: null, screenerCandidates: 3, curatedCandidates: 0, activeTradableCandidates: null }),
  'Universe: 0 listed ETFs/ETPs · unknown selected (3 active/mover · 0 curated) · unknown active/tradable');
  assert.equal(formatEtfDiscoverySummary({ mode: 'configured' }), null);
});

test('paper setup alert identifies direction, levels, costs-adjusted R:R, and both volume baselines', () => {
  const line = formatEtfResult({ symbol: 'SPY', status: 'reserved', candidate: {
    direction: 'long', entryPrice: 500.125, stopPrice: 497.5, targetPrice: 505.25,
    signal: { relativeVolume: 1.8, timeOfDayRelativeVolume: { status: 'available', ratio: 2.13, sampleSessions: 8 } },
  }, decision: { sizing: { rewardRisk: 1.67, proposedRiskUsd: 24.5 } } });
  assert.match(line, /SPY LONG \| PAPER RESERVED \(not a fill\)/);
  assert.match(line, /Entry \$500\.13 · Stop \$497\.50 · Target \$505\.25/);
  assert.match(line, /Net R:R 1\.67 · Risk budget \$24\.50/);
  assert.match(line, /Session RVOL 1\.80x · ToD RVOL 2\.13x\/8 sessions/);
});

test('Discord summary puts approved paper setups before a large list of screen rejections', () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ symbol: `S${index}`, status: 'no-setup' }));
  rows[18] = { symbol: 'LATE', status: 'reserved' };
  const shown = prioritizeEtfAlertRows(rows);
  assert.equal(shown.length, 5);
  assert.equal(shown[0].symbol, 'LATE');
});

test('paper-alert formatter does not imply a trade for non-candidate outcomes', () => {
  assert.equal(formatEtfResult({ symbol: 'TLT', status: 'no-setup', reasons: ['no_unique_confirmed_breakout'] }),
    'TLT | no-setup | no_unique_confirmed_breakout');
});

test('classified ETP paper alerts identify wrapper type and disclose modeled gaps', () => {
  const line = formatEtfResult({ symbol: 'ETN1', status: 'reserved', candidate: {
    direction: 'long', entryPrice: 20, stopPrice: 19, targetPrice: 22,
    instrumentMetadata: { productType: 'inverse_etf', leverage: -2, inverse: true, riskNotices: ['daily_reset_path_risk'] },
    signal: { relativeVolume: 2, timeOfDayRelativeVolume: { status: 'unavailable' } },
  }, decision: { sizing: { rewardRisk: 2, proposedRiskUsd: 10 } } });
  assert.match(line, /ETN1 LONG \| INVERSE_ETF -2x inverse \| Product risk: .* \| PAPER RESERVED/);
  assert.match(line, /daily reset\/path risk \(not modeled\)/);
});
