import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPrimaryResearchForFuture } from '../src/sharedSignals.js';

const record = (id, owner, symbol, direction = 'long', extra = {}) => ({
  id, owner, symbol, direction, status: 'active', observedAt: '2026-09-29T14:00:00.000Z', strategyId: 'scalp',
  paperOnly: true, executable: false, ...extra,
});

test('matches recent non-self bot context through declared futures exposure', () => {
  const input = { contract: { symbol: 'MESZ6', exposureKey: 'SPY' } };
  const rows = matchPrimaryResearchForFuture(input, [
    record('spy', 'stocks', 'SPY', 'long', { catalystContextStatus: 'available', catalystContext: [{ publisher: 'Wire', headline: 'Earnings update', sourceUrl: 'https://news.example/a', activityAt: '2026-09-29T14:00:00Z' }] }),
    record('upro', 'stocks', 'UPRO', 'short'),
    record('qqq', 'stocks', 'QQQ', 'long'),
    record('btc', 'crypto', 'BTC'),
    record('self-owner', 'futures', 'SPY'),
    record('shared-exposure', 'forex', 'EUR_USD', 'short', { exposureKey: 'SPY', strategyFamily: 'intraday_day_trade' }),
    record('executable', 'stocks', 'SPY', 'long', { executable: true }),
    record('not-paper', 'stocks', 'SPY', 'long', { paperOnly: false }),
    record('long-hold', 'stocks', 'SPY', 'long', { strategyId: 'long-hold' }),
    record('terminal', 'stocks', 'SPY', 'short', { status: 'target_hit' }),
  ]);
  assert.deepEqual(rows.map((row) => [row.id, row.direction]), [['spy', 'long'], ['upro', 'short'], ['shared-exposure', 'short']]);
  assert.ok(rows.every((row) => row.executable === false && row.paperOnly === true));
  assert.equal(rows[0].catalystContext[0].headline, 'Earnings update');
  assert.equal(rows[0].catalystContextStatus, 'available');
});

test('crypto futures can receive BTC context but unrelated assets and absent keys do not match', () => {
  const context = [record('btc', 'crypto', 'BTC'), record('eth', 'crypto', 'ETH')];
  assert.deepEqual(matchPrimaryResearchForFuture({ contract: { exposureKey: 'BTC' } }, context).map((row) => row.id), ['btc']);
  assert.deepEqual(matchPrimaryResearchForFuture({ contract: { exposureKey: 'GC' } }, context), []);
  assert.deepEqual(matchPrimaryResearchForFuture({ contract: {} }, context), []);
});

test('keeps only the freshest journal row per primary owner and symbol', () => {
  const newest = record('new', 'stocks', 'SPY', 'short');
  const older = record('old', 'stocks', 'SPY', 'long', { observedAt: '2026-09-29T13:00:00.000Z' });
  assert.deepEqual(matchPrimaryResearchForFuture({ contract: { exposureKey: 'SPY' } }, [newest, older]).map((row) => row.id), ['new']);
});
