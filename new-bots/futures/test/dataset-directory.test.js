import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createFuturesDirectoryAccumulator, definitionRange, discoverDatabentoDatasetDirectory } from '../src/databentoDatasetDirectory.js';
import { loadOrDiscoverFuturesContracts } from '../src/contractDiscoveryCache.js';

const now = Date.parse('2026-10-02T16:00:00.000Z'), start = '2026-10-02T00:00:00.000Z', end = '2026-10-02T15:30:00.000Z';
const products = [{ symbol: 'E-mini', providerSymbol: 'ES.v.0' }];
const definition = (id, root = 'ES', extra = {}) => ({ hd: { publisher_id: 1, instrument_id: id }, asset: root,
  raw_symbol: `${root}Z6`, instrument_class: 'F', security_update_action: 'A', ts_recv: '2026-10-02T10:00:00.000Z',
  expiration: '2026-12-18T14:30:00.000Z', exchange: 'XCME', ...extra });
const rangeMetadata = { schema: { definition: { start: '2010-01-01T00:00:00.000Z', end } } };
const stream = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const fixture = (body, cost = '0.01') => {
  const calls = [];
  return { calls, fetcher: async (url, options = {}) => { calls.push({ url, options });
    if (url.includes('get_dataset_range')) return new Response(JSON.stringify(rangeMetadata));
    if (url.includes('get_cost')) return new Response(cost);
    return new Response(body);
  } };
};
const directory = async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'omni-dataset-directory-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
};
const options = { now, products, dataset: 'GLBX.MDP3', apiKey: 'fixture-key', maxScanCostUsd: 1 };

test('all roots discovered independently of priorities, strict classes and publisher-scoped identity', () => {
  const a = createFuturesDirectoryAccumulator({ ...options, start, end });
  [definition(1), definition(2, 'NEWROOT'), definition(1, 'OTHER', { hd: { publisher_id: 2, instrument_id: 1 } }),
    definition(3, 'ES', { instrument_class: 'C' }), definition(4, 'ES', { instrument_class: 'S' }),
    definition(5, 'ES', { expiration: start }), definition(6, 'ES', { activation: '2026-10-03T00:00:00Z' }),
    definition(7, 'ES', { asset: '' }), definition(8, 'ES', { hd: { instrument_id: 8 } })].forEach(a.add);
  const result = a.finish();
  assert.equal(result.diagnostics.records, 9);
  assert.equal(result.diagnostics.uniqueIdentities, 8);
  assert.equal(result.diagnostics.unexpiredOutrights, 3);
  assert.equal(result.diagnostics.discoveredRoots, 3);
  assert.equal(result.diagnostics.outsideConfiguredPriorities, 2);
  assert.deepEqual(result.diagnostics.rejectionReasons, { invalid_provider_identity: 1, option_contract: 1, spread_contract: 1,
    expired_contract: 1, not_yet_activated: 1, missing_root_or_raw_symbol: 1 });
  assert.ok(result.contracts.every((c) => !c.tradeEligible && !c.contractSpecVerified && c.providerTickValue === null));
  assert.equal(result.contracts.find((c) => c.providerRoot === 'NEWROOT').providerSymbol, null);
});

test('latest deletions, conflicts, invalid time and class changes cannot resurrect an older contract', () => {
  const a = createFuturesDirectoryAccumulator({ ...options, start, end });
  [definition(1), definition(1, 'ES', { security_update_action: 'D', ts_recv: '2026-10-02T11:00:00Z' }), definition(1),
    definition(2), definition(2, 'OTHER'), definition(2), definition(3), definition(3, 'ES', { ts_recv: 'bad' }),
    definition(3, 'ES', { ts_recv: '2026-10-02T11:00:00Z' }), definition(4),
    definition(4, 'ES', { instrument_class: 'S', ts_recv: '2026-10-02T11:00:00Z' })].forEach(a.add);
  const result = a.finish();
  assert.equal(result.contracts.length, 0);
  assert.equal(result.diagnostics.supersededRecords, 7);
  assert.deepEqual(result.diagnostics.rejectionReasons, { deleted_definition: 1, conflicting_definition_revision: 1,
    invalid_definition_time: 1, spread_contract: 1 });
});

test('fixed-point price references use the explicit encoding; no heuristic tick value becomes verified', () => {
  const a = createFuturesDirectoryAccumulator({ ...options, start, end });
  a.add(definition(1, 'LE', { min_price_increment: '25000000', display_factor: '10000000',
    min_price_increment_amount: '10000000000', unit_of_measure_qty: '40000000000000', contract_multiplier: 1 }));
  a.add(definition(2, 'ES', { min_price_increment: '9223372036854775807', display_factor: null, contract_multiplier: true }));
  const [es, le] = a.finish().contracts;
  assert.equal(le.providerTickSize, 0.025);
  assert.equal(le.providerDisplayFactor, 0.01);
  assert.equal(le.providerContractSize, 40000);
  assert.equal(le.providerTickValue, null);
  assert.equal(es.providerTickSize, null);
  assert.equal(es.providerContractMultiplier, null);
});

test('availability uses latest provider schema date and exclusive end without requesting tomorrow', () => {
  assert.deepEqual(definitionRange(rangeMetadata, now), { start, end, providerAvailableEnd: end });
  assert.equal(definitionRange({ schema: { definition: { ...rangeMetadata.schema.definition, end: start } } }, now).start, '2026-10-01T00:00:00.000Z');
  assert.equal(definitionRange(rangeMetadata, Date.parse('2026-10-02T14:00:00Z')).end, '2026-10-02T14:00:00.000Z');
  assert.throws(() => definitionRange({}, now), /availability/);
  assert.throws(() => definitionRange(rangeMetadata, now + 8 * 86_400_000), /recent/);
});

test('credential/cost gates and estimate-only probe never download a paid stream', async () => {
  const f = fixture('');
  assert.equal((await discoverDatabentoDatasetDirectory({ ...options, apiKey: '', ...f })).status, 'credentials_missing');
  assert.equal((await discoverDatabentoDatasetDirectory({ ...options, maxScanCostUsd: 0, ...f })).status, 'cost_cap_required');
  assert.equal(f.calls.length, 0);
  const plan = await discoverDatabentoDatasetDirectory({ ...options, ...f, planOnly: true });
  assert.equal(plan.status, 'estimate_only');
  assert.equal(plan.diagnostics.uniqueIdentities, null);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((c) => !c.url.includes('timeseries')));
});

test('full stream crosses chunks, retains unconfigured roots and archives raw + all dispositions', async (t) => {
  const root = await directory(t), body = stream(Array.from({ length: 6001 }, (_, i) => definition(i + 1, i === 6000 ? 'LASTROOT' : `R${i}`)));
  const f = fixture(body);
  const rawFetch = f.fetcher;
  f.fetcher = async (url, options) => {
    const response = await rawFetch(url, options);
    if (!url.includes('timeseries')) return response;
    const data = new TextEncoder().encode(body);
    return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < data.length; i += 317) controller.enqueue(data.slice(i, i + 317)); controller.close(); } }));
  };
  const result = await discoverDatabentoDatasetDirectory({ ...options, ...f, archiveDirectory: root });
  assert.equal(result.status, 'refreshed');
  assert.equal(result.contracts.length, 6001);
  assert.ok(result.contracts.some((c) => c.providerRoot === 'LASTROOT'));
  const request = new URLSearchParams(f.calls.at(-1).options.body);
  assert.equal(request.get('symbols'), 'ALL_SYMBOLS');
  assert.equal(request.get('limit'), null);
  assert.equal(request.get('pretty_px'), 'false');
  assert.equal(request.get('stype_in'), 'raw_symbol');
  const archived = gunzipSync(await readFile(result.archive.rawFile));
  assert.equal(archived.toString(), body);
  assert.equal(createHash('sha256').update(archived).digest('hex'), result.archive.sha256);
  const normalized = JSON.parse(gunzipSync(await readFile(result.archive.normalizedFile)));
  assert.equal(normalized.contracts.length, 6001);
  assert.equal(normalized.diagnostics.streamComplete, true);
  assert.equal(JSON.stringify(normalized).includes('fixture-key'), false);
});

test('cost cap stops before download and missing estimate is never interpreted as free', async (t) => {
  const root = await directory(t), f = fixture('', '1.01');
  const result = await discoverDatabentoDatasetDirectory({ ...options, ...f, archiveDirectory: root });
  assert.equal(result.status, 'cost_cap_exceeded'); assert.equal(f.calls.length, 2);
  assert.equal(result.diagnostics.unexpiredOutrights, null);
  await assert.rejects(discoverDatabentoDatasetDirectory({ ...options, ...fixture('', ''), archiveDirectory: root }), /Invalid.*cost/);
});

test('partial, malformed, oversized and empty responses cannot publish complete directory coverage', async (t) => {
  const root = await directory(t);
  for (const [body, limits] of [[JSON.stringify(definition(1)), {}], ['{broken}\n', {}], ['', {}],
    [stream([definition(1), definition(2)]), { maxRecords: 1 }], [stream([definition(1)]), { maxBytes: 10 }]]) {
    const f = fixture(body), metrics = [];
    const r = await discoverDatabentoDatasetDirectory({ ...options, ...f, ...limits, metrics, archiveDirectory: root });
    assert.equal(r.status, 'incomplete_stream'); assert.equal(r.diagnostics.uniqueIdentities, null);
    assert.equal(r.contracts.length, 0); assert.equal(f.calls.length, 3);
    assert.equal(metrics.filter((m) => m.operation === 'estimated-contract-discovery-cost').length, 1);
  }
  assert.ok((await readdir(root)).every((name) => name.endsWith('.failure.json')));
});

test('failed paid HTTP is not retried and its body or arbitrary transport secrets are not retained', async (t) => {
  const root = await directory(t), f = fixture('');
  const wrapped = f.fetcher;
  f.fetcher = async (url, opts) => { const r = await wrapped(url, opts); return url.includes('timeseries') ? new Response('secret-token', { status: 429 }) : r; };
  const r = await discoverDatabentoDatasetDirectory({ ...options, ...f, archiveDirectory: root });
  assert.equal(r.status, 'incomplete_stream'); assert.equal(f.calls.length, 3);
  assert.ok(!JSON.stringify(r).includes('secret-token'));
});

test('scheduler dataset mode works without priority products, caches only complete results and accounts for expiry', async (t) => {
  const root = await directory(t), cachePath = join(root, 'directory.json');
  const f = fixture(stream([definition(1, 'NEW', { expiration: '2026-10-02T16:30:00Z' })]));
  const args = { ...options, ...f, enabled: true, scope: 'dataset', products: [], cachePath, maxAgeMs: 6 * 60 * 60_000 };
  const fresh = await loadOrDiscoverFuturesContracts(args);
  assert.equal(fresh.status, 'refreshed'); assert.equal(fresh.contracts.length, 1);
  const cached = await loadOrDiscoverFuturesContracts({ ...args, now: now + 60 * 60_000 });
  assert.equal(cached.status, 'cached'); assert.equal(cached.contracts.length, 0);
  assert.equal(cached.diagnostics.unexpiredOutrights, 1, 'source-date count preserved');
  assert.equal(cached.diagnostics.currentlyUnexpiredReferences, 0);
  assert.equal(f.calls.length, 3);
  assert.ok(!(await readFile(cachePath, 'utf8')).includes('fixture-key'));
});

test('durable backoff prevents repeated partial paid downloads and account/dataset cache scopes cannot mix', async (t) => {
  const root = await directory(t), cachePath = join(root, 'directory.json'), f = fixture('{bad}\n');
  const args = { ...options, ...f, enabled: true, scope: 'dataset', cachePath };
  assert.equal((await loadOrDiscoverFuturesContracts(args)).status, 'incomplete_stream');
  assert.equal((await loadOrDiscoverFuturesContracts({ ...args, now: now + 60_000 })).status, 'refresh_backoff');
  assert.equal(f.calls.length, 3);
  const good = fixture(stream([definition(1)]));
  assert.equal((await loadOrDiscoverFuturesContracts({ ...args, ...good, now: now + 61 * 60_000 })).status, 'refreshed');
  const absent = await loadOrDiscoverFuturesContracts({ ...args, apiKey: '', now: now + 62 * 60_000 });
  assert.equal(absent.status, 'credentials_missing'); assert.equal(absent.diagnostics.uniqueIdentities, null);
  const different = fixture(stream([definition(1)]));
  assert.equal((await loadOrDiscoverFuturesContracts({ ...args, ...different, dataset: 'OTHER.MDP3', now: now + 63 * 60_000 })).status, 'refreshed');
  assert.equal(different.calls.length, 3);
});

test('directory refresh locks fail closed without deleting another writer lock', async (t) => {
  const root = await directory(t), cachePath = join(root, 'directory.json'), f = fixture('');
  await writeFile(`${cachePath}.lock`, 'owned by another writer');
  const result = await loadOrDiscoverFuturesContracts({ ...options, ...f, enabled: true, scope: 'dataset', cachePath });
  assert.equal(result.status, 'refresh_locked'); assert.equal(f.calls.length, 0);
  assert.equal(await readFile(`${cachePath}.lock`, 'utf8'), 'owned by another writer');
});

test('a new UTC date rechecks definitions without repurchasing an unchanged historical source interval', async (t) => {
  const root = await directory(t), cachePath = join(root, 'directory.json'), f = fixture(stream([definition(1)]));
  const args = { ...options, ...f, enabled: true, scope: 'dataset', cachePath, maxAgeMs: 86_400_000 };
  const initial = await loadOrDiscoverFuturesContracts(args);
  assert.equal(initial.status, 'refreshed');
  const nextDate = await loadOrDiscoverFuturesContracts({ ...args, now: now + 9 * 60 * 60_000 });
  assert.equal(nextDate.status, 'cached'); assert.equal(nextDate.availabilityRechecked, true);
  assert.equal(nextDate.diagnostics.observedFrom, initial.diagnostics.observedFrom, 'previous-date IDs are not relabelled current');
  assert.equal(f.calls.length, 4, 'only free availability metadata added, not another cost/download request');
});
