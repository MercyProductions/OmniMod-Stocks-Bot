import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchProtocolFundamentals, validateProtocolSlug } from '../src/protocolFundamentals.js';

const now = Date.UTC(2026, 8, 27);
function response(body, ok = true, status = 200) { return { ok, status, json: async () => body }; }
function tvl() { return { tvl: [365, 90, 30, 0].map((days) => ({ date: Math.floor((now - days * 86_400_000) / 1000), totalLiquidityUSD: 1000 + (365 - days) * 2 })) }; }

test('protocol slug requires an exact safe provider slug', () => {
  assert.equal(validateProtocolSlug(' Uniswap-v3 '), 'uniswap-v3');
  for (const bad of ['https://api.llama.fi', '../protocols', 'a--b', 'x?y']) assert.throws(() => validateProtocolSlug(bad));
  assert.equal(validateProtocolSlug(''), '');
});

test('free path captures dated TVL history and does not request paid endpoints without a key', async () => {
  const urls = [];
  const result = await fetchProtocolFundamentals('uniswap', { now, fetch: async (url) => { urls.push(String(url)); return response(tvl()); } });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/api\.llama\.fi\/protocol\/uniswap$/);
  assert.match(result.tvlStatus, /^available;/);
  assert.ok(Math.abs(result.tvlFacts.find((fact) => fact.key === 'protocol_tvl_change_30d').value - ((1730 / 1670 - 1) * 100)) < 1e-9);
  assert.equal(result.financialStatus, 'not configured');
  assert.equal(result.usageStatus, 'not configured');
});

test('paid path adds documented financial and emission endpoints while preserving free TVL fallback', async () => {
  const urls = [];
  const result = await fetchProtocolFundamentals('uniswap', { now, apiKey: 'secret-key', fetch: async (url) => {
    const value = String(url); urls.push(value);
    if (value.includes('api.llama.fi/protocol/')) return response({ ...tvl(), id: 'protocol#uniswap' });
    if (value.endsWith('/api/hacks')) return response([
      { defillamaId: 'protocol#uniswap', date: Math.floor((now - 10 * 86_400_000) / 1000), name: 'Different alias is ignored', classification: 'Protocol Logic', technique: 'Reentrancy', amount: 1200, chain: ['Ethereum'], source: 'https://example.com/incident' },
      { defillamaId: 'another-project', date: Math.floor((now - 5 * 86_400_000) / 1000), name: 'Uniswap', classification: 'Other', amount: 9999 }
    ]);
    if (value.includes('financial-statement')) return response({ aggregates: {
      yearly: { '2024': { 'Gross Protocol Revenue': { value: 999 }, 'Token Holder Net Income': { value: 99 } } },
      quarterly: { '2026-Q2': { 'Gross Protocol Revenue': { value: 22 }, 'Token Holder Net Income': { value: 7 } } },
      monthly: { '2026-08': { 'Gross Protocol Revenue': { value: 50 }, 'Token Holder Net Income': { value: 8 }, Earnings: { value: null } } }
    } });
    if (value.includes('active-users') && value.includes('dailyActiveUsers')) return response({ total24h: 1200, total7d: 7600, total30d: 25000, total1y: null });
    if (value.includes('active-users') && value.includes('dailyTransactionCount')) return response({ total24h: 8000, total7d: 50000, total30d: 200000, total1y: 2400000 });
    return response({ body: JSON.stringify({ name: 'Uniswap', supplyMetrics: { maxSupply: 1000, adjustedSupply: 700, incentiveAmount: 100, nonIncentiveAmount: 600, tbdAmount: null },
      documentedData: { tokenAllocation: { current: { insiders: 15, community: 60, unknown: null }, final: { insiders: 20, community: 80 } } },
      metadata: { events: [{ timestamp: Math.floor((now + 7 * 86_400_000) / 1000), noOfTokens: [12, 3], category: 'investors', unlockType: 'cliff', description: 'Next unlock' },
        { timestamp: Math.floor((now + 14 * 86_400_000) / 1000), noOfTokens: [12, null], category: 'team', unlockType: 'linear' }] } }), lastModified: '2026-09-20' });
  } });
  assert.equal(urls.length, 5);
  assert.ok(urls.every((url) => url.startsWith('https://')));
  assert.equal(result.financialStatus, 'available');
  assert.equal(result.financialFacts.find((fact) => fact.key === 'token_holder_net_income_usd').value, 8);
  assert.equal(result.financialFacts.some((fact) => fact.key === 'protocol_earnings_usd'), false);
  assert.match(result.financialFacts[0].label, /monthly; 2026-08/);
  assert.equal(result.usageStatus, 'available; 7 reported fields');
  assert.deepEqual(result.usageFacts.find((fact) => fact.key === 'protocol_active_users_24h'), {
    key: 'protocol_active_users_24h', label: 'Protocol-reported active users (24h aggregate)', value: 1200, unit: 'users'
  });
  assert.equal(result.usageFacts.find((fact) => fact.key === 'protocol_transactions_30d').value, 200000);
  assert.equal(result.emissions.available, true);
  assert.equal(result.emissions.upcomingEvents[0].tokenAmount, 15);
  assert.equal(result.emissions.supplyMetrics.maxSupply, 1000);
  assert.equal(result.emissions.supplyMetrics.tbdAmount, null);
  assert.deepEqual(result.emissions.allocation.current, { insiders: 15, community: 60 });
  assert.equal(result.emissions.upcomingEvents[1].tokenAmount, null);
  assert.equal(result.security.status, 'not enabled');
  assert.ok(!JSON.stringify(result).includes('secret-key'));
});

test('paid exploit history is separately opt-in and matches only the exact protocol identifier', async () => {
  const urls = [];
  const result = await fetchProtocolFundamentals('uniswap', { now, apiKey: 'private-key', hacksEnabled: true, fetch: async (url) => {
    const value = String(url); urls.push(value);
    if (value.includes('api.llama.fi/protocol/')) return response({ ...tvl(), id: 'protocol#uniswap' });
    if (value.endsWith('/api/hacks')) return response([
      { name: 'Other alias', defillamaId: 'different-id', date: now / 1000, amount: 999 },
      { name: 'Uniswap exploit', defillamaId: 'protocol#uniswap', date: Math.floor((now - 2 * 86_400_000) / 1000), amount: 125000, classification: 'Protocol Logic', technique: 'Bad accounting', chain: ['Ethereum'], source: 'https://example.com/report', bridgeHack: false }
    ]);
    if (value.includes('financial-statement')) return response({ aggregates: {} });
    if (value.includes('/api/emission/')) return response({ body: { metadata: { events: [] } } });
    if (value.includes('dailyActiveUsers')) return response({});
    if (value.includes('dailyTransactionCount')) return response({});
    throw new Error('unexpected request');
  } });
  assert.ok(urls.includes('https://pro-api.llama.fi/private-key/api/hacks'));
  assert.equal(result.security.status, 'available');
  assert.equal(result.security.protocolId, 'protocol#uniswap');
  assert.equal(result.security.incidentCount, 1);
  assert.equal(result.security.events[0].amountUsd, 125000);
  assert.equal(result.security.events[0].classification, 'Protocol Logic');
  assert.ok(!JSON.stringify(result).includes('private-key'));
});

test('paid exploit endpoint is not called when disabled and does not fuzzy match names', async () => {
  const result = await fetchProtocolFundamentals('uniswap', { now, apiKey: 'private-key', fetch: async (url) => {
    if (String(url).includes('api.llama.fi/protocol/')) return response({ ...tvl(), id: 'protocol#uniswap' });
    if (String(url).endsWith('/api/hacks')) throw new Error('should not request hacks while disabled');
    if (String(url).includes('financial-statement')) return response({ aggregates: {} });
    if (String(url).includes('/api/emission/')) return response({ body: { metadata: { events: [] } } });
    return response({});
  } });
  assert.equal(result.security.status, 'not enabled');
});

test('paid exploit source failure remains an explicit unavailable status', async () => {
  const result = await fetchProtocolFundamentals('uniswap', { now, apiKey: 'private-key', hacksEnabled: true, fetch: async (url) => {
    if (String(url).includes('api.llama.fi/protocol/')) return response({ ...tvl(), id: 'protocol#uniswap' });
    if (String(url).endsWith('/api/hacks')) return response({ error: 'provider-private-error-sentinel' }, false, 403);
    if (String(url).includes('financial-statement')) return response({ aggregates: {} });
    if (String(url).includes('/api/emission/')) return response({ body: { metadata: { events: [] } } });
    return response({});
  } });
  assert.equal(result.security.status, 'request failed');
  assert.equal(result.security.incidentCount, null);
  assert.ok(!JSON.stringify(result).includes('private-key'));
  assert.ok(!JSON.stringify(result).includes('provider-private-error-sentinel'));
});

test('paid endpoint failures do not discard free TVL results or expose error contents', async () => {
  const result = await fetchProtocolFundamentals('uniswap', { now, apiKey: 'private-key', fetch: async (url) => {
    if (String(url).includes('api.llama.fi/protocol/')) return response(tvl());
    return response({ error: 'private-key was rejected' }, false, 403);
  } });
  assert.match(result.tvlStatus, /^available;/);
  assert.equal(result.financialStatus, 'request failed');
  assert.equal(result.usageStatus, 'request failed');
  assert.match(result.emissions.note, /failed/);
  assert.ok(!JSON.stringify(result).includes('private-key'));
});

test('paid activity status preserves a failed endpoint when its paired response has no supported fields', async () => {
  const result = await fetchProtocolFundamentals('uniswap', { now, apiKey: 'private-key', fetch: async (url) => {
    const value = String(url);
    if (value.includes('api.llama.fi/protocol/')) return response(tvl());
    if (value.includes('financial-statement')) return response({ aggregates: {} });
    if (value.includes('/api/emission/')) return response({ body: { metadata: { events: [] } } });
    if (value.includes('dailyActiveUsers')) return response({ unsupported: true });
    return response({ error: 'request failed' }, false, 403);
  } });
  assert.match(result.tvlStatus, /^available;/);
  assert.equal(result.usageFacts.length, 0);
  assert.equal(result.usageStatus, 'partial; 0 reported fields; 1 request(s) failed');
});

test('null TVL fields stay missing instead of becoming observed zero', async () => {
  const result = await fetchProtocolFundamentals('uniswap', { now, fetch: async () => response({ tvl: [
    { date: Math.floor(now / 1000), totalLiquidityUSD: null },
    { date: Math.floor((now - 86_400_000) / 1000), totalLiquidityUSD: 100 }
  ] }) });
  assert.equal(result.tvlFacts.length, 1);
  assert.equal(result.tvlFacts[0].value, 100);
  assert.match(result.tvlStatus, /1d old/);
});
