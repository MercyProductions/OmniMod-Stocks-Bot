import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Stocks directory, corporate actions and backfills reserve shared slots and honor another worker cooldown', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stocks-budget-routes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  process.env.OMNIMOD_STOCKS_DATA_DIR = join(root, 'data');
  process.env.STOCKS_SEC_USER_AGENT = '';
  process.env.STOCKS_ALPACA_NEWS_ENABLED = 'true';
  process.env.STOCKS_FRED_API_KEY = '';
  process.env.ALPACA_SHARED_RATE_DIR = join(root, 'budget');
  const { captureUniverseSnapshot } = await import('../src/universeStore.js');
  const { enrichAssetsWithIntelligence } = await import('../src/eventIntelligence.js');
  const { requestAlpacaBackfillJson } = await import('../src/alpacaBackfillRequest.js');
  const { createProviderMetrics, summarizeProviderMetrics } = await import('../src/scanDiagnostics.js');
  const { createSharedAlpacaRequestGate, inspectAlpacaSharedBudget } = await import('../../new-bots/shared/alpacaSharedBudget.js');
  const key = 'route-fixture-only', keys = { alpaca_key_id: key, alpaca_secret_key: 'fixture-secret' };
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async url => {
    requests++;
    const u = new URL(url);
    assert.ok(u.hostname.endsWith('.alpaca.markets'));
    const payload = u.pathname === '/v2/assets' ? [{ id: 'fixture-id', symbol: 'AAA', exchange: 'NYSE', status: 'active', tradable: true }]
      : u.pathname === '/v1/corporate-actions' ? { corporate_actions: {} } : u.pathname === '/v1beta1/news' ? { news: [] } : { bars: {} };
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(payload), json: async () => payload };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const metrics = createProviderMetrics();
  await captureUniverseSnapshot('budget-routes', keys, new Date(), metrics);
  const enriched = await enrichAssetsWithIntelligence([{ symbol: 'AAA' }], keys, {}, new Date(), metrics);
  assert.equal(enriched.assets[0].recentNewsStatus, 'available');
  assert.equal(metrics.requests.filter(row => row.provider === 'Alpaca news').length, 1);
  await requestAlpacaBackfillJson('https://data.alpaca.markets/v2/stocks/bars', { keyId: key, secretKey: 'fixture-secret' });
  const budget = await inspectAlpacaSharedBudget({ directory: process.env.ALPACA_SHARED_RATE_DIR });
  assert.equal(requests, 4); assert.equal(budget.buckets[0].grantsTotal, 4);
  const other = createSharedAlpacaRequestGate({ directory: process.env.ALPACA_SHARED_RATE_DIR });
  await other.defer(key, 60000);
  await assert.rejects(captureUniverseSnapshot('blocked-routes', keys, new Date(), metrics), { code: 'ALPACA_PACING_DEFERRED' });
  const blocked = await enrichAssetsWithIntelligence([{ symbol: 'BBB' }], keys, {}, new Date(), metrics);
  assert.equal(blocked.assets[0].corporateActionDataStatus, 'provider_error');
  await assert.rejects(requestAlpacaBackfillJson('https://data.alpaca.markets/v2/stocks/bars', { keyId: key, secretKey: 'fixture-secret' }), { code: 'ALPACA_PACING_DEFERRED' });
  assert.equal(requests, 4);
  assert.equal(summarizeProviderMetrics(metrics).reduce((sum, row) => sum + row.budgetDeferrals, 0), 3);
});
