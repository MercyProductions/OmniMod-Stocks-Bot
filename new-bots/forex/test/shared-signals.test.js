import test from 'node:test';
import assert from 'node:assert/strict';
import { formatForexObservationLines } from '../src/diagnostics.js';
import { mapForexPrimaryResearch, parseForexPrimarySignalMap } from '../src/sharedSignals.js';

const records = [
  { id: 's1', owner: 'stocks', symbol: 'FXE', direction: 'long', observedAt: '2026-09-29T14:00:00.000Z', strategyId: 'stocks:intraday', status: 'active', executable: false, paperOnly: true,
    catalystContext: [{ headline: 'Currency fund update', publisher: 'Example', activityAt: '2026-09-29T13:59:00.000Z' }] },
  { id: 's2', owner: 'stocks', symbol: 'FXE', direction: 'short', observedAt: '2026-09-29T14:01:00.000Z', strategyId: 'stocks:intraday', status: 'active', executable: false, paperOnly: true },
  { id: 'c1', owner: 'crypto', symbol: 'BTC', direction: 'long', observedAt: '2026-09-29T14:01:00.000Z', strategyId: 'crypto:momentum', status: 'active', executable: false, paperOnly: true },
  { id: 's3', owner: 'stocks', symbol: 'FXE', direction: 'long', observedAt: '2026-09-29T14:02:00.000Z', strategyId: 'long-hold', status: 'active', executable: false, paperOnly: true },
  { id: 's4', owner: 'stocks', symbol: 'FXE', direction: 'long', observedAt: '2026-09-29T14:02:00.000Z', strategyId: 'stocks:intraday', status: 'active', executable: true, paperOnly: true },
  { id: 'f1', owner: 'futures', symbol: '6EZ6', exposureKey: 'EUR_USD', direction: 'long', observedAt: '2026-09-29T14:03:00.000Z', strategyFamily: 'intraday_day_trade', strategyId: 'futures-fx-v1', status: 'active', executable: false, paperOnly: true },
];

test('Forex shares only mapped active intraday Stocks/Crypto research as unscored native-direction context', () => {
  const result = new Map(mapForexPrimaryResearch(['EUR_USD', 'GBP_USD'], records, { EUR_USD: ['FXE'] }));
  assert.equal(result.get('EUR_USD').length, 2);
  assert.equal(result.get('EUR_USD').find((row) => row.id === 's2').direction, 'short');
  assert.equal(result.get('EUR_USD').find((row) => row.id === 'f1').owner, 'futures');
  assert.equal(result.get('EUR_USD')[0].interpretation, 'native direction; not translated to the FX pair');
  assert.ok(result.get('EUR_USD').every((row) => row.executable === false));
  assert.equal(result.get('GBP_USD').length, 0);
  const lines = formatForexObservationLines([{ instrument: 'EUR_USD', bias: 'TIMEFRAMES DISAGREE', primaryResearch: result.get('EUR_USD') }], 'test');
  assert.match(lines.join('\n'), /Shared research \(unscored; paper-only\): stocks\/FXE native short/);
  assert.match(lines.join('\n'), /not translated into EUR_USD direction/);
});

test('Forex shared research rejects unknown owners, inactive rows, unknown horizons, and malformed records', () => {
  const filtered = mapForexPrimaryResearch(['EUR_USD'], [
    { ...records[0], owner: 'prediction-markets' },
    { ...records[0], id: 'inactive', status: 'closed' },
    { ...records[0], id: 'unknown', strategyId: 'unknown' },
    { ...records[0], id: 'missing-proof', executable: undefined },
    { ...records[0], id: 'missing-paper', paperOnly: false },
  ], { EUR_USD: ['FXE'] });
  assert.deepEqual(filtered[0][1], []);
  assert.throws(() => mapForexPrimaryResearch(['EUR_USD'], records, { EURUSD: ['FXE'] }), /BASE_QUOTE/);
  assert.throws(() => mapForexPrimaryResearch(['EUR_USD'], records, { EUR_USD: ['NOT A TICKER'] }), /invalid symbol/);
});

test('Forex directly matches a peer market paper signal by declared currency exposure', () => {
  const [row] = mapForexPrimaryResearch(['EUR_USD'], [records.at(-1)], {});
  assert.equal(row[1].length, 1);
  assert.equal(row[1][0].owner, 'futures');
  assert.equal(row[1][0].interpretation, 'native direction; not translated to the FX pair');
});

test('Forex shared-signal mapping JSON is explicit and validates its top-level shape', () => {
  assert.deepEqual(parseForexPrimarySignalMap('{"EUR_USD":["FXE"]}'), { EUR_USD: ['FXE'] });
  assert.throws(() => parseForexPrimarySignalMap('not-json'), /JSON object/);
  assert.throws(() => parseForexPrimarySignalMap('[]'), /JSON object/);
});
