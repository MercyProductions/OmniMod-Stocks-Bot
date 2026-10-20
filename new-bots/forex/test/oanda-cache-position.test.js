import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { loadOandaDirectory, saveOandaDirectory, oandaDirectoryCachePath } from '../src/oandaDirectoryCache.js';
import { loadForexPositionQuotes, toExecutableForexQuote } from '../src/positionQuotes.js';

const now = Date.parse('2026-10-02T14:00:00Z');
const definition = (name, extra = {}) => ({ name, type: 'CURRENCY', ...extra });
const price = (instrument, at = now) => ({ instrument, time: new Date(at).toISOString(),
  bids: [{ price: '1.1' }], asks: [{ price: '1.1001' }], status: 'tradeable' });

test('malformed price primitives cannot become executable position marks', () => {
  for (const bad of [true, false, null, '', ' ', [], {}, Infinity]) {
    const quote = { ...price('EUR_USD'), bids: [{ price: bad }] };
    assert.equal(toExecutableForexQuote(quote).quality, 'non-executable');
  }
});
async function clean(directory) {
  const rel = relative(tmpdir(), directory);
  assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
  await rm(directory, { recursive: true, force: true });
}

test('account-scoped directory cache reuses complete membership, refreshes changes, and retains quote observations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-fx-cache-'));
  try {
    const path = oandaDirectoryCachePath({ account: 'private-account-a', directory });
    assert.ok(!path.includes('private-account'));
    assert.notEqual(path, oandaDirectoryCachePath({ account: 'private-account-b', directory }));
    const initial = await loadOandaDirectory({ path, now,
      fetchInstruments: async () => ({ instruments: [definition('EUR_USD'), definition('USD_SGD')] }) });
    await saveOandaDirectory({ path, state: initial.state, quoteRows: { EUR_USD: price('EUR_USD') }, now });
    const cached = await loadOandaDirectory({ path, now: now + 30_000,
      fetchInstruments: async () => { throw new Error('Fresh membership must not be re-requested.'); } });
    assert.equal(cached.diagnostics.source, 'fresh_cache');
    assert.equal(cached.previousQuotes.EUR_USD.time, new Date(now).toISOString());
    const refreshed = await loadOandaDirectory({ path, now: now + 3_600_001,
      fetchInstruments: async () => ({ instruments: [definition('EUR_USD', { tradeUnitsPrecision: 1 }), definition('USD_ZAR')] }) });
    assert.deepEqual(refreshed.diagnostics.membershipDelta,
      { baseline: false, added: ['USD_ZAR'], removed: ['USD_SGD'], changed: ['EUR_USD'] });
    await saveOandaDirectory({ path, state: refreshed.state, now: now + 3_600_001 });
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.membershipHistory.length, 2);
    assert.equal(saved.instruments.some((row) => row.name === 'USD_SGD'), false);
    assert.equal(JSON.stringify(saved).includes('private-account'), false);
  } finally { await clean(directory); }
});

test('expired directory refresh failures never authorize stale fallback; corrupt cache is rebuilt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-fx-cache-fail-'));
  try {
    const path = oandaDirectoryCachePath({ account: 'fixture-account', directory });
    const initial = await loadOandaDirectory({ path, now, fetchInstruments: async () => ({ instruments: [definition('EUR_USD')] }) });
    await saveOandaDirectory({ path, state: initial.state, now });
    await assert.rejects(loadOandaDirectory({ path, now: now + 86_400_001,
      fetchInstruments: async () => { throw new Error('provider unavailable'); } }), /unavailable/);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).fetchedAt, now, 'Failed refresh must not erase last known evidence.');
    await writeFile(path, '{broken-json');
    const rebuilt = await loadOandaDirectory({ path, now: now + 2,
      fetchInstruments: async () => ({ instruments: [definition('USD_SGD')] }) });
    assert.equal(rebuilt.diagnostics.cacheReadStatus, 'invalid');
    assert.equal(rebuilt.payload.instruments[0].name, 'USD_SGD');
  } finally { await clean(directory); }
});

test('position quote loader reuses full discovery quotes and fetches missing/stale off-shortlist instruments', async () => {
  const calls = [];
  const result = await loadForexPositionQuotes({ instruments: ['USD_SGD', 'USD_ZAR', 'EUR_USD', 'USD_SGD'], now,
    quoteRows: { USD_SGD: price('USD_SGD'), EUR_USD: price('EUR_USD', now - 121_000) },
    fetchPrices: async (pairs) => { calls.push(pairs); return { prices: pairs.map((pair) => price(pair)) }; } });
  assert.deepEqual(calls, [['USD_ZAR', 'EUR_USD']]);
  assert.equal(result.quotes.size, 3);
  assert.equal(result.failures.length, 0);
});

test('position quote loader bounds batch size and rejects duplicates, missing rows, and failed requests', async () => {
  const names = Array.from({ length: 51 }, (_, i) => 'PAIR_' + i);
  const calls = [];
  const result = await loadForexPositionQuotes({ instruments: names, now,
    fetchPrices: async (pairs) => {
      calls.push(pairs);
      if (pairs.length === 1) throw new Error('fixture failure');
      return { prices: [price(pairs[0]), price(pairs[0]), ...pairs.slice(2).map((pair) => price(pair))] };
    } });
  assert.deepEqual(calls.map((pairs) => pairs.length), [50, 1]);
  assert.equal(result.quotes.size, 48);
  assert.deepEqual(result.failures.map((row) => row.reason),
    ['duplicate_quote_identity', 'provider_returned_no_quote', 'position_quote_request_failed']);
});
