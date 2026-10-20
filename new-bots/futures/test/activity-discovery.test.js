import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import { discoverFuturesActivity, futuresActivityRange } from '../src/futuresActivityDiscovery.js';
import { now, start, end, contract, directory, bar } from './fixtures/activity.mjs';

const lines = (rows) => rows.map(JSON.stringify).join('\n') + '\n';
const c = contract(1);
const settings = { enabled: true, directory: directory([c]), dataset: 'GLBX.MDP3', apiKey: 'fixture-key', now, maxScanCostUsd: 1 };
const temporary = async (t) => { const p = await mkdtemp(join(tmpdir(), 'omni-activity-')); t.after(() => rm(p, { recursive: true, force: true })); return p; };
function fixture({ body = lines([bar(c, 58), bar(c)]), cost = '0.1', availableEnd = end, status = 200 } = {}) {
  const calls = [];
  return { calls, fetcher: async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('get_dataset_range')) return new Response(JSON.stringify({ schema: { 'ohlcv-1m': { start: '2010-01-01T00:00:00Z', end: availableEnd } } }));
    if (url.includes('get_cost')) return new Response(cost);
    return new Response(body, { status });
  } };
}

test('disabled/unconfigured/invalid directory research makes no paid or metadata requests', async () => {
  const f = fixture();
  assert.equal((await discoverFuturesActivity({ ...settings, ...f, enabled: false })).status, 'disabled');
  assert.equal((await discoverFuturesActivity({ ...settings, ...f, apiKey: '' })).status, 'credentials_missing');
  assert.equal((await discoverFuturesActivity({ ...settings, ...f, directory: null })).status, 'directory_not_current');
  assert.equal((await discoverFuturesActivity({ ...settings, ...f, maxScanCostUsd: 0 })).status, 'cost_cap_required');
  assert.equal(f.calls.length, 0);
});

test('plan-only probe estimates availability/cost without a directory, disk writes or a paid request', async (t) => {
  const root = await temporary(t), f = fixture();
  const result = await discoverFuturesActivity({ ...settings, ...f, directory: null, maxScanCostUsd: 0, planOnly: true, cachePath: join(root, 'unused.json') });
  assert.equal(result.status, 'estimate_only'); assert.equal(result.plan.estimatedCostUsd, 0.1);
  assert.equal(result.plan.paidDownloads, 0); assert.equal(result.diagnostics.observed, null);
  assert.equal(f.calls.length, 2); assert.equal((await readdir(root)).length, 0);
});

test('minute availability excludes incomplete bars and cannot join instrument IDs across dates', () => {
  const meta = { schema: { 'ohlcv-1m': { start: '2010-01-01T00:00:00Z', end: '2026-10-02T16:00:20Z' } } };
  const r = futuresActivityRange(meta, { now });
  assert.equal(r.end, end); assert.equal(r.start, start);
  assert.equal(futuresActivityRange(meta, { now: now + 5 * 60_000 }).status, 'activity_availability_stale');
  const midnight = Date.parse('2026-10-02T00:00:30Z');
  assert.equal(futuresActivityRange(meta, { now: midnight }).status, 'awaiting_same_day_completed_bars');
  assert.equal(futuresActivityRange({}, { now }).status, 'activity_schema_unavailable');
});

test('all-symbol completed-minute stream is cached/archived and re-screened without another paid request', async (t) => {
  const root = await temporary(t), cachePath = join(root, 'activity.json'), f = fixture();
  const fresh = await discoverFuturesActivity({ ...settings, ...f, cachePath });
  assert.equal(fresh.status, 'screen_complete'); assert.equal(fresh.candidates.length, 1);
  assert.equal(f.calls.length, 3);
  const request = new URLSearchParams(f.calls.at(-1).options.body);
  for (const [key, value] of Object.entries({ symbols: 'ALL_SYMBOLS', schema: 'ohlcv-1m', map_symbols: 'true', pretty_px: 'true', pretty_ts: 'true', start, end }))
    assert.equal(request.get(key), value);
  assert.equal(request.has('limit'), false);
  const archived = JSON.parse(gunzipSync(await readFile(fresh.archive.normalizedFile)));
  assert.equal(archived.rows.length, 1); assert.equal(archived.rows[0].tradeEligible, false);
  const metrics = [];
  const cached = await discoverFuturesActivity({ ...settings, ...f, cachePath, metrics, now: now + 20_000, maxCandidates: 2 });
  assert.equal(cached.diagnostics.cached, true); assert.equal(cached.candidates.length, 1);
  assert.equal(f.calls.length, 4, 'only availability metadata is repeated');
  assert.equal(metrics.filter((m) => m.operation === 'estimated-activity-discovery-cost').length, 0);
  assert.ok(!(await readFile(cachePath, 'utf8')).includes('fixture-key'));
});

test('cached inputs receive new directory membership and cannot reuse stale shortlist approval', async (t) => {
  const root = await temporary(t), cachePath = join(root, 'activity.json'), f = fixture();
  await discoverFuturesActivity({ ...settings, ...f, cachePath });
  const changed = directory([contract(1, 'CHANGED', { providerRawSymbol: 'CHANGEDZ6' })]);
  const result = await discoverFuturesActivity({ ...settings, ...f, cachePath, directory: changed });
  assert.equal(result.diagnostics.cached, true); assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.rejectionReasons.raw_symbol_mismatch, 1);
  assert.equal(f.calls.length, 4);
});

test('unknown/excluded classes do not masquerade as observed outright bars', async (t) => {
  const root = await temporary(t), cachePath = join(root, 'activity.json');
  const f = fixture({ body: lines([bar(contract(999), 58), bar(contract(999))]) });
  const result = await discoverFuturesActivity({ ...settings, ...f, cachePath });
  assert.equal(result.status, 'screen_complete'); assert.equal(result.diagnostics.observed, 0);
  assert.equal(result.diagnostics.unobserved, 1); assert.equal(result.candidates.length, 0);
  const archived = JSON.parse(gunzipSync(await readFile(result.archive.normalizedFile)));
  assert.equal(archived.recordDispositions.length, 2);
});

test('stale schema availability and over-cap cost do not trigger a download', async (t) => {
  const root = await temporary(t), cachePath = join(root, 'activity.json');
  const stale = fixture({ availableEnd: '2026-10-02T15:50:00Z' });
  assert.equal((await discoverFuturesActivity({ ...settings, ...stale, cachePath })).status, 'activity_availability_stale');
  assert.equal(stale.calls.length, 1);
  const expensive = fixture({ cost: '1.01' });
  assert.equal((await discoverFuturesActivity({ ...settings, ...expensive, cachePath })).status, 'cost_cap_exceeded');
  assert.equal(expensive.calls.length, 2);
  const empty = fixture({ cost: '' });
  assert.equal((await discoverFuturesActivity({ ...settings, ...empty, cachePath })).status, 'invalid_cost_estimate');
  assert.equal(empty.calls.length, 2);
});

test('incomplete paid stream remains a reserved expense and cannot be retried for the same window', async (t) => {
  const root = await temporary(t), cachePath = join(root, 'activity.json'), f = fixture({ body: JSON.stringify(bar(c)) }), metrics = [];
  const first = await discoverFuturesActivity({ ...settings, ...f, cachePath, metrics });
  assert.equal(first.status, 'activity_scan_incomplete'); assert.equal(first.diagnostics.observed, null);
  assert.equal(first.diagnostics.failureReason, 'unterminated_stream');
  assert.equal(metrics.filter((m) => m.operation === 'estimated-activity-discovery-cost').length, 1);
  const second = await discoverFuturesActivity({ ...settings, ...f, cachePath });
  assert.equal(second.status, 'previous_window_attempt_failed');
  assert.equal(f.calls.filter((r) => r.url.includes('timeseries')).length, 1);
  assert.equal((await readdir(`${cachePath}.archives`)).length, 0);
});

test('resource, schema, malformed and HTTP errors return no partial candidates', async (t) => {
  const root = await temporary(t);
  for (const [index, custom] of [{ body: '' }, { body: '{oops}\n' }, { status: 429 }, { maxRecords: 1 }, { maxBytes: 10 }].entries()) {
    const f = fixture(custom), result = await discoverFuturesActivity({ ...settings, ...f, ...custom, cachePath: join(root, `test${index}.json`) });
    assert.equal(result.status, 'activity_scan_incomplete'); assert.equal(result.candidates.length, 0);
    assert.equal(f.calls.filter((r) => r.url.includes('timeseries')).length, 1);
  }
});

test('retrieval delay ages out candidates at completion and corrupted cache fails closed', async (t) => {
  const root = await temporary(t), cachePath = join(root, 'activity.json'), f = fixture();
  let time = 0;
  const original = f.fetcher;
  f.fetcher = async (...args) => { const r = await original(...args); if (args[0].includes('timeseries')) time += 50_000; return r; };
  const result = await discoverFuturesActivity({ ...settings, ...f, cachePath, maxBarAgeMs: 60_000, clock: () => time });
  assert.equal(result.status, 'screen_complete'); assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.rejectionReasons.stale_last_bar, 1);
  await writeFile(result.archive.rawFile, gzipSync(lines([bar(c, 58, { volume: 999 }), bar(c)])));
  const cache = await discoverFuturesActivity({ ...settings, ...f, cachePath });
  assert.equal(cache.status, 'activity_scan_incomplete'); assert.equal(cache.candidates.length, 0);
  assert.equal(cache.diagnostics.failureReason, 'cache_integrity_failed');
  assert.equal(f.calls.filter((r) => r.url.includes('timeseries')).length, 1);
});

test('another process lock is respected without deleting its ownership evidence', async (t) => {
  const root = await temporary(t), cachePath = join(root, 'activity.json'), f = fixture();
  await writeFile(`${cachePath}.lock`, 'another process');
  const result = await discoverFuturesActivity({ ...settings, ...f, cachePath });
  assert.equal(result.status, 'activity_refresh_locked'); assert.equal(f.calls.length, 1);
  assert.equal(await readFile(`${cachePath}.lock`, 'utf8'), 'another process');
});
