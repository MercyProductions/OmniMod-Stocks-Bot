import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { discoverDatabentoActiveFuturesContracts, discoverDatabentoFuturesContracts,
  normalizeDatabentoActiveContractDefinitions, normalizeDatabentoContractDefinitions } from '../src/databentoContractDiscovery.js';

const now = Date.parse('2026-09-29T16:00:00.000Z');
const products = [
  { symbol: 'E-mini S&P 500', providerSymbol: 'ES.v.0' },
  { symbol: 'Gold', providerSymbol: 'GC.v.0' },
];
const row = (id, raw, asset, expiry, extra = {}) => ({ publisher_id: 1, instrument_id: id, raw_symbol: raw, asset,
  instrument_class: 'F', expiration: expiry, ts_recv: '2026-09-29T15:00:00.000Z', ...extra });

test('volume-ranked continuous definitions yield one review-only prior-session leader per configured root', () => {
  const active = normalizeDatabentoActiveContractDefinitions(products, [
    row(10, 'ESZ6', 'ES', '2026-12-18T14:30:00.000Z'),
    row(11, 'ESM6', 'ES', '2026-10-18T14:30:00.000Z', { ts_recv: '2026-09-29T15:02:00.000Z' }),
    row(12, 'ESZ6-ESH7', 'ES', '2026-12-18T14:30:00.000Z', { instrument_class: 'S', ts_recv: '2026-09-29T15:03:00.000Z' }),
    row(13, 'GCV6', 'GC', '2026-10-28T17:30:00.000Z'),
    row(13, 'GCV6', 'GC', '2026-10-28T17:30:00.000Z', { security_update_action: 'D', ts_recv: '2026-09-29T15:05:00.000Z' }),
  ], { now });
  assert.deepEqual(active.contracts.map((contract) => contract.providerRawSymbol), ['ESM6']);
  assert.deepEqual(active.mappingStatus, [
    { product: 'E-mini S&P 500', providerSymbol: 'ES.v.0', status: 'resolved' },
    { product: 'Gold', providerSymbol: 'GC.v.0', status: 'no_current_mapping' },
  ]);
  assert.equal(active.contracts[0].volumeRankRule, 'previous-trading-session-highest-volume');
  assert.equal(active.contracts[0].contractState, 'volume_ranked_definition_only');
  assert.equal(active.contracts[0].contractSpecVerified, false);
  assert.equal(active.contracts[0].tradeEligible, false);
  assert.ok(active.contracts[0].unverifiedFields.includes('initial margin'));
});

test('active futures discovery enforces cost cap before the continuous definition stream', async () => {
  const calls = [];
  const metrics = [];
  await assert.rejects(discoverDatabentoActiveFuturesContracts(products, {
    apiKey: 'test-key', maxScanCostUsd: 0.01, now, metrics,
    fetcher: async (url) => { calls.push(url); return { ok: true, status: 200, text: async () => '0.02' }; },
  }), /exceeds configured cap/);
  assert.equal(calls.length, 1);
  assert.equal(metrics.at(-1).operation, 'estimated-active-contract-discovery-cost');
});

test('active futures discovery requests volume-ranked continuous definitions and preserves fail-closed metadata', async () => {
  const calls = [];
  const metrics = [];
  const discovery = await discoverDatabentoActiveFuturesContracts(products, {
    apiKey: 'test-key', maxScanCostUsd: 0.1, now, metrics,
    fetcher: async (url, options = {}) => {
      calls.push({ url, options });
      return url.includes('metadata.get_cost')
        ? { ok: true, status: 200, text: async () => '0.01' }
        : { ok: true, status: 200, text: async () => `${JSON.stringify(row(101, 'ESZ6', 'ES', '2026-12-18T14:30:00.000Z'))}\n` };
    },
  });
  assert.equal(calls.length, 2);
  const estimate = new URL(calls[0].url);
  assert.equal(estimate.searchParams.get('stype_in'), 'continuous');
  assert.equal(estimate.searchParams.get('symbols'), 'ES.v.0,GC.v.0');
  assert.equal(calls[1].options.method, 'POST');
  const request = new URLSearchParams(calls[1].options.body);
  assert.equal(request.get('schema'), 'definition');
  assert.equal(request.get('stype_in'), 'continuous');
  assert.equal(request.get('symbols'), 'ES.v.0,GC.v.0');
  assert.deepEqual(discovery.contracts.map((contract) => contract.providerRawSymbol), ['ESZ6']);
  assert.equal(discovery.contracts[0].tradeEligible, false);
  assert.equal(discovery.mappingStatus.filter((row) => row.status === 'resolved').length, 1);
  assert.equal(metrics.at(-1).operation, 'active-volume-ranked-definitions');
});

test('definition discovery keeps only latest unexpired outright contracts and never approves them', () => {
  const result = normalizeDatabentoContractDefinitions(products, [
    row(1, 'ESZ6', 'ES', '2026-12-18T14:30:00.000Z'),
    row(2, 'ESM6', 'ES', '2026-06-19T14:30:00.000Z'),
    row(3, 'ESZ6-ESH7', 'ES', '2026-12-18T14:30:00.000Z', { instrument_class: 'S' }),
    row(4, 'GCV6', 'GC', '2026-10-28T17:30:00.000Z'),
    row(5, 'GCZ6', 'GC', '2026-12-29T17:30:00.000Z', { security_update_action: 'D' }),
    row(1, 'ESZ6', 'ES', '2026-12-18T14:30:00.000Z', { ts_recv: '2026-09-29T15:01:00.000Z', security_update_action: 'D' }),
  ], { now });
  assert.equal(result.length, 1);
  assert.deepEqual(result.map((contract) => contract.providerRawSymbol), ['GCV6']);
  assert.equal(result[0].contractSpecVerified, false);
  assert.equal(result[0].tradeEligible, false);
  assert.ok(result[0].unverifiedFields.includes('initial margin'));
});

test('definition discovery retains provider-reported contract metadata without treating it as verified', () => {
  const [contract] = normalizeDatabentoContractDefinitions(products, [row(1, 'ESZ6', 'ES', '2026-12-18T14:30:00.000Z', {
    exchange: 'XCME', activation: '2026-09-01T00:00:00.000Z', min_price_increment: 250000000,
    display_factor: 1000000000, min_price_increment_amount: 12500000000, contract_multiplier: 50,
    unit_of_measure_qty: 50000000000, unit_of_measure: 'USD', currency: 'USD', security_type: 'FUT',
  })], { now });
  assert.equal(contract.providerExchange, 'XCME');
  assert.equal(contract.providerTickSize, 0.25);
  assert.equal(contract.providerTickValue, 12.5);
  assert.equal(contract.providerContractMultiplier, 50);
  assert.equal(contract.providerContractSize, 50);
  assert.equal(contract.providerCurrency, 'USD');
  assert.equal(contract.contractSpecVerified, false);
  assert.equal(contract.tradeEligible, false);
});

test('definition de-duplication keeps publisher-scoped instrument IDs separate', () => {
  const results = normalizeDatabentoContractDefinitions(products, [
    row(7, 'ESZ6', 'ES', '2026-12-18T14:30:00.000Z', { publisher_id: 1 }),
    row(7, 'ESM6', 'ES', '2026-10-18T14:30:00.000Z', { publisher_id: 2 }),
  ], { now });
  assert.deepEqual(results.map((contract) => contract.providerRawSymbol), ['ESM6', 'ESZ6']);
});

test('Databento definition discovery applies cost cap before requesting contract rows', async () => {
  let calls = 0;
  const metrics = [];
  await assert.rejects(discoverDatabentoFuturesContracts(products, {
    apiKey: 'test-key', maxScanCostUsd: 0.01, now, metrics,
    fetcher: async () => { calls++; return { ok: true, status: 200, text: async () => '0.02' }; },
  }), /exceeds configured cap/);
  assert.equal(calls, 1);
  assert.equal(metrics.at(-1).operation, 'estimated-contract-discovery-cost');
});

test('contract-discovery free cost metadata retries transient transport failure and records both attempts', async () => {
  const calls = [];
  const metrics = [];
  const delays = [];
  const result = await discoverDatabentoFuturesContracts(products, {
    apiKey: 'test-key', maxScanCostUsd: 0.1, now, metrics, sleep: async (ms) => delays.push(ms),
    fetcher: async (url, options = {}) => {
      calls.push({ url, options });
      if (String(url).includes('metadata.get_cost')) {
        if (calls.filter((call) => String(call.url).includes('metadata.get_cost')).length === 1) throw new TypeError('temporary disconnect');
        return { ok: true, status: 200, text: async () => '0.01' };
      }
      return { ok: true, status: 200, text: async () => `${JSON.stringify(row(1, 'ESZ6', 'ES', '2026-12-18T14:30:00.000Z'))}\n` };
    },
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [1000]);
  const costAttempts = metrics.filter((metric) => metric.operation === 'contract-definition-cost');
  assert.deepEqual(costAttempts.map((metric) => metric.status), [0, 200]);
  assert.equal(costAttempts[1].retry, true);
  assert.equal(result.contracts[0].tradeEligible, false);
});

test('Databento definition discovery requests the configured parent outright definitions', async () => {
  const calls = [];
  const metrics = [];
  const result = await discoverDatabentoFuturesContracts(products, {
    apiKey: 'test-key', maxScanCostUsd: 0.1, now, metrics,
    fetcher: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.includes('metadata.get_cost')) return { ok: true, status: 200, text: async () => '0.01' };
      return { ok: true, status: 200, text: async () => `${JSON.stringify(row(1, 'ESZ6', 'ES', '2026-12-18T14:30:00.000Z'))}\n` };
    },
  });
  assert.equal(calls.length, 2);
  const request = new URL(calls[0].url);
  assert.equal(request.searchParams.get('stype_in'), 'parent');
  assert.equal(request.searchParams.get('schema'), 'definition');
  assert.equal(request.searchParams.get('symbols'), 'ES.FUT,GC.FUT');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(new URLSearchParams(calls[1].options.body).get('schema'), 'definition');
  assert.deepEqual(result.contracts.map((contract) => contract.providerRawSymbol), ['ESZ6']);
  assert.equal(result.contracts[0].tradeEligible, false);
  assert.equal(metrics.at(-1).operation, 'contract-definitions');
});

test('Databento outright definitions honor one bounded 429 Retry-After and record both attempts', async () => {
  const calls = [], metrics = [], delays = [];
  const result = await discoverDatabentoFuturesContracts(products, { apiKey: 'test-key', maxScanCostUsd: 0.1, now, metrics,
    sleep: async (ms) => delays.push(ms), fetcher: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('metadata.get_cost')) return { ok: true, status: 200, text: async () => '0.01' };
      if (calls.filter((call) => call.url.endsWith('/timeseries.get_range')).length === 1) return {
        ok: false, status: 429, headers: new Headers({ 'Retry-After': '1' }), text: async () => 'rate limited' };
      return { ok: true, status: 200, text: async () => `${JSON.stringify(row(1, 'ESZ6', 'ES', '2026-12-18T14:30:00.000Z'))}\n` };
    } });
  assert.equal(calls.filter((call) => call.url.endsWith('/timeseries.get_range')).length, 2);
  assert.deepEqual(delays, [1000]);
  assert.deepEqual(metrics.filter((metric) => metric.operation === 'contract-definitions').map((metric) => metric.status), [429, 200]);
  assert.equal(result.contracts[0].tradeEligible, false);
});

test('all configured micro roots are included in the bounded Databento definition request', async () => {
  const universePath = fileURLToPath(new URL('../examples/futures.json', import.meta.url));
  const configuredProducts = JSON.parse(await readFile(universePath, 'utf8'));
  const calls = [];
  const result = await discoverDatabentoFuturesContracts(configuredProducts, {
    apiKey: 'test-key', maxScanCostUsd: 0.1, now,
    fetcher: async (url, options = {}) => {
      calls.push({ url, options });
      return url.includes('metadata.get_cost')
        ? { ok: true, status: 200, text: async () => '0.01' }
        : { ok: true, status: 200, text: async () => '' };
    },
  });
  assert.equal(result.contracts.length, 0, 'empty mock response does not imply discovery or eligibility');
  assert.equal(calls.length, 2, 'cost estimate precedes the one definitions request');
  const roots = new URL(calls[0].url).searchParams.get('symbols').split(',');
  for (const root of ['MES.FUT', 'MNQ.FUT', 'M2K.FUT', 'MYM.FUT', 'MCL.FUT', 'MGC.FUT']) assert.ok(roots.includes(root), root);
  for (const root of ['ZC.FUT','MZC.FUT','XC.FUT','ZS.FUT','MZS.FUT','XK.FUT','ZW.FUT','MZW.FUT','XW.FUT','KE.FUT','MKC.FUT','ZL.FUT','MZL.FUT','ZM.FUT','MZM.FUT','LE.FUT','GF.FUT','HE.FUT']) assert.ok(roots.includes(root), root);
  const requested = new URLSearchParams(calls[1].options.body).get('symbols').split(',');
  assert.deepEqual(requested, roots);
});

test('definition discovery rejects missing credentials and malformed provider records', async () => {
  await assert.rejects(discoverDatabentoFuturesContracts(products, { now }), /API_KEY is required/);
  assert.deepEqual(normalizeDatabentoContractDefinitions(products, ['not-a-definition'], { now }), []);
  await assert.rejects(discoverDatabentoFuturesContracts(products, {
    apiKey: 'test-key', maxScanCostUsd: 1, now,
    fetcher: async (url) => ({ ok: true, status: 200, text: async () => url.includes('metadata.get_cost') ? '0' : '{bad}\n' }),
  }), /malformed definition/);
});
