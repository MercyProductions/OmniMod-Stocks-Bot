import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { STOCK_DISCOVERY_VERSION } from '../src/stockDirectory.js';

test('a changed ETP review invalidates a cached Stocks broad-market snapshot', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'omnimod-stocks-ownership-cache-'));
  const previous = { dataDir: process.env.OMNIMOD_STOCKS_DATA_DIR, registry: process.env.ETF_ETP_CLASSIFICATION_PATH,
    key: process.env.ALPACA_API_KEY_ID, secret: process.env.ALPACA_API_SECRET_KEY };
  process.env.OMNIMOD_STOCKS_DATA_DIR = dataDir;
  process.env.ALPACA_API_KEY_ID = '';
  process.env.ALPACA_API_SECRET_KEY = '';
  const classificationPath = join(dataDir, 'classifications.json');
  process.env.ETF_ETP_CLASSIFICATION_PATH = classificationPath;
  try {
    const { getStockDiscoveryOwnership } = await import('../src/etfDirectory.js');
    const { fetchMarketUniverse } = await import('../src/stocksData.js');
    const { paths, writeMarketSnapshot } = await import('../src/storage.js');
    const now = new Date();
    const directory = { schemaVersion: 1, fetchedAt: now.toISOString(), symbols: ['BND'] };
    const row = (symbol) => ({ symbol, productType: 'etn', exposureKey: 'SPY', leverage: 1, inverse: false,
      sourceUrl: 'https://issuer.example/product', reviewedAt: now.toISOString() });
    await writeFile(paths.etfDirectoryCache(), JSON.stringify(directory));
    await writeFile(classificationPath, JSON.stringify([row('ETN1')]));
    const first = await getStockDiscoveryOwnership({ directory, classificationPath, now });
    await writeMarketSnapshot('cache-test', { fetchedAt: now.toISOString(), source: 'fixture',
      assets: [{ symbol: 'AAA', provider: 'Alpaca IEX', price: 10, lastUpdated: now.toISOString(), freshness: 'fresh' }],
      dynamicDiscovery: { version: STOCK_DISCOVERY_VERSION, enabled: true, mode: 'regular', etfDirectory: { ownershipRevision: first.revision } } });
    const settings = { watchlist: ['AAA'], discoveryMinutes: 15, dailyCacheHours: 8, encryptedProviderKeys: {} };
    const unchanged = await fetchMarketUniverse('cache-test', { settings, dynamicDiscovery: true, now, fetcher: async () => {
      throw new Error('Market requests are unnecessary for a valid cached snapshot.');
    } });
    assert.equal(unchanged.cacheHit, true);
    assert.notEqual(unchanged.stale, true);

    await writeFile(classificationPath, JSON.stringify([row('ETN2')]));
    const changed = await fetchMarketUniverse('cache-test', { settings, dynamicDiscovery: true, now, fetcher: async () => {
      throw new Error('No provider requests expected without credentials.');
    } });
    assert.equal(changed.stale, true);
    assert.match(changed.providerError, /No usable stock chart data/);
  } finally {
    for (const [key, value] of Object.entries({ OMNIMOD_STOCKS_DATA_DIR: previous.dataDir,
      ETF_ETP_CLASSIFICATION_PATH: previous.registry, ALPACA_API_KEY_ID: previous.key, ALPACA_API_SECRET_KEY: previous.secret })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const rel = relative(tmpdir(), dataDir); assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(dataDir, { recursive: true, force: true });
  }
});
