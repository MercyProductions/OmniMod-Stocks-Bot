import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeH1History } from '../src/databentoH1Normalization.js';
import { fetchDatabentoFuturesH1Trend } from '../src/databentoTrendData.js';
import { remainingFuturesHistoricalBudget } from '../src/historicalCostBudget.js';

const now = Date.parse('2026-10-02T16:00:00Z');
const contract = { symbol: 'ES', providerSymbol: 'ES.v.0', providerRawSymbol: 'ESZ6', contractId: 'CME:ES:202612', exposureKey: 'SPY',
  expiry: '2026-12-18T14:30:00Z', activeContract: true, contractSpecVerified: true, specSource: 'https://www.cmegroup.com/',
  specVerifiedAt: new Date(now - 60_000).toISOString(), multiplier: 50, tickSize: .25, tickValueUsd: 12.5, initialMarginUsd: 1000, maintenanceMarginUsd: 900 };
const input = [{ contract }];
const bars = () => Array.from({ length: 52 }, (_, i) => ({ hd: { ts_event: new Date(now - (53 - i) * 3_600_000).toISOString(),
  rtype: 34, publisher_id: 1, instrument_id: 123 }, symbol: 'ESZ6', open: '100.0', high: '102.0', low: '99.0', close: '101.0', volume: '100' }));
const lines = (rows = bars()) => rows.map(JSON.stringify).join('\n') + '\n';
const normalize = (records, options = {}, inputs = input) => normalizeH1History(inputs, records, { now, ...options });
const options = (extra = {}) => ({ now, apiKey: 'test-key', maxScanCostUsd: 1, ...extra });
const fetcher = (rows = bars()) => async (url) => new Response(String(url).includes('metadata.get_cost') ? '0.004' : lines(rows));
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'omni-h1-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'cache.json');
}

test('documented nested H1 JSON reaches complete history with source identity and sparse intervals preserved', () => {
  const result = normalize(bars());
  assert.equal(result.rows[0].trendDataStatus, 'complete');
  assert.equal(result.rows[0].trendBars.length, 52);
  assert.equal(result.rows[0].trendDataMissingIntervals, 0);
  assert.equal(result.rows[0].trendDataAsOf, '2026-10-02T15:00:00.000Z');
  assert.equal(result.diagnostics.recordDispositions.h1_accepted_bar, 52);
  const sparse = bars(); sparse.splice(20, 1);
  assert.equal(normalize(sparse).rows[0].trendDataStatus, 'complete');
  assert.equal(normalize(sparse).rows[0].trendDataMissingIntervals, 1);
  assert.equal(normalize(sparse).rows[0].trendBars.length, 51);
});

test('display prices are never scaled by magnitude and malformed numeric coercions cannot qualify', () => {
  const large = bars().map((b) => ({ ...b, open: 2e8, high: 2e8 + 2, low: 2e8 - 1, close: 2e8 + 1 }));
  assert.equal(normalize(large).rows[0].trendBars[0].close, 2e8 + 1);
  const low = bars().map((b) => ({ ...b, open: '.05', high: '.06', low: '.04', close: '.055' }));
  assert.equal(normalize(low).rows[0].trendBars[0].close, .055);
  for (const value of [true, false, null, '', ' ', [], {}, 'NaN', 'Infinity', '0x10']) {
    const records = bars(); records[0].open = value;
    assert.ok(normalize(records).rows[0].trendDataReasons.includes('h1_ohlcv_invalid'), String(value));
  }
  for (const volume of ['1.5', -1, Number.MAX_SAFE_INTEGER + 1, null]) {
    const records = bars(); records[0].volume = volume;
    assert.equal(normalize(records).rows[0].trendDataStatus, 'incomplete');
  }
  const negative = bars(); Object.assign(negative[0], { open: -3, high: -1, low: -4, close: -2 });
  assert.ok(normalize(negative).rows[0].trendDataReasons.includes('h1_nonpositive_price_strategy_ineligible'));
});

test('schema, mapping, header, timestamp and publisher corruption invalidate the affected contract', () => {
  const cases = [
    ['h1_schema_mismatch', (b) => b.hd.rtype = 33],
    ['h1_identity_missing_or_invalid', (b) => b.hd.instrument_id = 0],
    ['h1_timestamp_invalid_or_unaligned', (b) => b.hd.ts_event = '2026-10-02T14:05:00Z'],
    ['h1_timestamp_invalid_or_unaligned', (b) => b.hd.ts_event = '2026-02-30T14:00:00Z'],
    ['h1_header_conflict', (b) => b.ts_event = '2026-10-02T14:00:00Z'],
    ['h1_symbol_mapping_conflict', (b) => b.raw_symbol = 'CLZ6'],
    ['h1_publisher_changed', (b) => b.hd.publisher_id = 2],
    ['h1_symbol_mapping_missing', (b) => delete b.symbol],
  ];
  for (const [reason, change] of cases) {
    const records = bars(); change(records[0]);
    const row = normalize(records).rows[0];
    assert.equal(row.trendDataStatus, 'incomplete', reason);
    assert.ok(row.trendDataReasons.includes(reason), JSON.stringify(row.trendDataReasons));
    assert.deepEqual(row.trendBars, []);
  }
  const result = normalize(bars(), {}, [{ contract: { ...contract, providerPublisherId: 2 } }]);
  assert.ok(result.rows[0].trendDataReasons.includes('h1_contract_publisher_mismatch'));
});

test('date-scoped ID changes are accepted across dates, same-date changes and cross-symbol collisions are rejected', () => {
  const daily = bars().map((b) => ({ ...b, hd: { ...b.hd, instrument_id: Number(b.hd.ts_event.slice(8, 10)) } }));
  assert.equal(normalize(daily).rows[0].trendDataStatus, 'complete');
  daily.at(-1).hd.instrument_id = 999;
  assert.ok(normalize(daily).rows[0].trendDataReasons.includes('h1_ambiguous_symbol_identity'));
  const foreign = { ...bars()[0], symbol: 'CLZ6' };
  assert.ok(normalize([...bars(), foreign]).rows[0].trendDataReasons.includes('h1_identity_symbol_conflict'));
});

test('identical duplicates are counted once; conflicting revisions cannot silently overwrite a bar', () => {
  const data = bars();
  const duplicate = normalize([...data, structuredClone(data[0])]);
  assert.equal(duplicate.rows[0].trendDataStatus, 'complete');
  assert.equal(duplicate.rows[0].trendBars.length, 52);
  assert.equal(duplicate.diagnostics.recordDispositions.h1_identical_duplicate_bar, 1);
  const conflict = normalize([...data, { ...data[0], close: 101.5 }]);
  assert.ok(conflict.rows[0].trendDataReasons.includes('h1_conflicting_duplicate_bar'));
});

test('completion time controls freshness and metadata validity; no stale history is approved during retrieval', async () => {
  let tick = 0;
  const result = await fetchDatabentoFuturesH1Trend(input, options({ clock: () => tick,
    fetcher: async (url) => {
      if (String(url).includes('metadata.get_cost')) { tick += 6 * 60_000; return new Response('0'); }
      return new Response(lines());
    } }));
  assert.equal(result.rows[0].trendDataStatus, 'incomplete');
  assert.ok(result.rows[0].trendDataReasons.includes('h1_history_stale_or_missing'));
  assert.equal(result.diagnostics.evaluatedAt, '2026-10-02T16:06:00.000Z');
});

test('preflight blocks invalid limits, dataset metadata mismatch and malformed cost without paid requests', async () => {
  let calls = 0;
  const noCall = async () => { calls++; throw new Error('unexpected'); };
  for (const policy of [{ minBars: 49 }, { maxBars: 49 }, { minBars: NaN }, { lookbackDays: 7.5 }, { maxBytes: Infinity }, { maxRecords: 100001 }])
    await assert.rejects(fetchDatabentoFuturesH1Trend(input, options({ ...policy, fetcher: noCall })));
  const metadata = await fetchDatabentoFuturesH1Trend([{ contract: { ...contract, providerDataset: 'OTHER.DATA' } }], options({ fetcher: noCall }));
  assert.equal(metadata.diagnostics.preflightRejectionReasons.h1_contract_dataset_mismatch, 1);
  assert.equal(calls, 0);
  for (const cost of ['', ' ', 'null', 'true', 'NaN', '-1', '1e999', '0x1']) {
    let count = 0;
    await assert.rejects(fetchDatabentoFuturesH1Trend(input, options({ fetcher: async () => { count++; return new Response(cost); } })), /invalid H1 cost/);
    assert.equal(count, 1);
  }
});

test('real stream parsing fails closed on malformed, oversized, excessive, empty and interrupted data', async () => {
  for (const [body, limits, reason] of [
    [lines() + '{broken', {}, /malformed H1/], [lines(), { maxBytes: 100 }, /byte limit/],
    [lines(), { maxRecords: 10 }, /record limit/], ['', {}, /response is empty/], ['null\n', {}, /malformed H1/],
  ]) {
    await assert.rejects(fetchDatabentoFuturesH1Trend(input, options({ ...limits,
      fetcher: async (url) => new Response(String(url).includes('metadata.get_cost') ? '0' : body) })), reason);
  }
  let calls = 0;
  const metrics = [];
  await assert.rejects(fetchDatabentoFuturesH1Trend(input, options({ metrics, fetcher: async (url) => {
    calls++;
    if (String(url).includes('metadata.get_cost')) return new Response('.2');
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(lines())); controller.error(new Error('secret-from-provider')); } }));
  } })), /stream failed/);
  assert.equal(calls, 2);
  assert.equal(remainingFuturesHistoricalBudget(1, metrics), .8);
  assert.equal(JSON.stringify(metrics).includes('secret-from-provider'), false);
});

test('completed-hour cache reuses the raw query without HTTP or cost and reapplies current gates', async (t) => {
  const cachePath = await temp(t), requests = [];
  const transport = async (url, init) => { requests.push({ url: String(url), init }); return fetcher()(url); };
  const first = await fetchDatabentoFuturesH1Trend(input, options({ cachePath, fetcher: transport }));
  assert.equal(first.diagnostics.cache.hit, false);
  const saved = await readFile(cachePath, 'utf8');
  assert.equal(saved.includes('test-key'), false);
  const metrics = [];
  const second = await fetchDatabentoFuturesH1Trend(input, options({ now: now + 60_000, maxScanCostUsd: 0, cachePath, fetcher: transport, metrics }));
  assert.equal(second.diagnostics.cache.hit, true);
  assert.equal(second.rows[0].trendDataStatus, 'complete');
  assert.equal(second.diagnostics.estimatedCostUsd, 0);
  assert.equal(requests.length, 2);
  assert.deepEqual(metrics, []);
  const higher = await fetchDatabentoFuturesH1Trend(input, options({ cachePath, minBars: 55, fetcher: transport }));
  assert.equal(higher.diagnostics.cache.hit, true);
  assert.ok(higher.rows[0].trendDataReasons.includes('h1_history_insufficient'));
  const older = await fetchDatabentoFuturesH1Trend(input, options({ now: now + 6 * 60_000, cachePath, fetcher: transport }));
  assert.ok(older.rows[0].trendDataReasons.includes('h1_history_stale_or_missing'));
  assert.equal(requests.length, 2);
  assert.equal(new URLSearchParams(requests[1].init.body).get('end'), '2026-10-02T16:00:00.000Z');
});

test('H1 cache key separates account, dataset and hour boundaries', async (t) => {
  const cachePath = await temp(t); let calls = 0;
  const transport = async (url) => { calls++; return fetcher()(url); };
  await fetchDatabentoFuturesH1Trend(input, options({ cachePath, fetcher: transport }));
  await fetchDatabentoFuturesH1Trend(input, options({ cachePath, apiKey: 'other-test-key', fetcher: transport }));
  await fetchDatabentoFuturesH1Trend(input, options({ cachePath, dataset: 'OTHER.DATA', fetcher: transport }));
  await fetchDatabentoFuturesH1Trend(input, options({ cachePath, now: now + 3_600_000, fetcher: transport }));
  assert.equal(calls, 8);
});

test('corrupt cache and overlapping refresh prevent requests rather than repurchasing or racing', async (t) => {
  const cachePath = await temp(t); let calls = 0;
  const transport = async (url) => { calls++; return fetcher()(url); };
  await fetchDatabentoFuturesH1Trend(input, options({ cachePath, fetcher: transport }));
  const cached = JSON.parse(await readFile(cachePath, 'utf8')); cached.body += ' ';
  await writeFile(cachePath, JSON.stringify(cached));
  await assert.rejects(fetchDatabentoFuturesH1Trend(input, options({ cachePath, fetcher: transport })), /integrity/);
  await writeFile(`${cachePath}.lock`, 'test-lock');
  await assert.rejects(fetchDatabentoFuturesH1Trend(input, options({ cachePath, fetcher: transport })), /locked/);
  assert.equal(calls, 2);
});

test('failed query attempts survive changes of symbol set without exposing provider errors', async (t) => {
  const cachePath = await temp(t); let calls = 0;
  await assert.rejects(fetchDatabentoFuturesH1Trend(input, options({ cachePath, fetcher: async (url) => {
    calls++; if (String(url).includes('metadata.get_cost')) return new Response('0.2'); throw new Error('test-secret');
  } })), /stream failed/);
  const different = [{ contract: { ...contract, symbol: 'CL', providerRawSymbol: 'CLZ6' } }];
  await fetchDatabentoFuturesH1Trend(different, options({ cachePath, fetcher: async (url) => { calls++; return fetcher(bars().map((b) => ({ ...b, symbol: 'CLZ6' })))(url); } }));
  await assert.rejects(fetchDatabentoFuturesH1Trend(input, options({ cachePath, fetcher: async () => { calls++; } })), /automatic retry blocked/);
  assert.equal(calls, 4);
  assert.equal((await readFile(`${cachePath}.attempt.json`, 'utf8')).includes('test-secret'), false);
});
