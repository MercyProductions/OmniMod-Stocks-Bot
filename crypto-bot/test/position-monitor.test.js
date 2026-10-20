import { fillRiskPolicyFixture } from '../../new-bots/shared/fixtures/fillRiskPolicy.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coinbaseBookEvidence, krakenBookEvidence, cryptoRulesFixture } from '../../new-bots/shared/fixtures/cryptoBookEvidence.js';
import { loadPaperPositionIdentity } from '../src/paperIdentityCache.js';
import { parseKrakenPositionQuote, collectKrakenPositionQuotes } from '../src/krakenPositionQuotes.js';
const directory = await mkdtemp(join(tmpdir(), 'omnimod-crypto-position-tests-'));
process.env.OMNIMOD_CRYPTO_DATA_DIR = directory;
process.env.OMNIMOD_TEST_ISOLATE_DATA_DIR = '1';
const { fetchCryptoPositionQuotes } = await import('../src/positionQuotes.js');
const { refreshCryptoPaperIdentity } = await import('../src/marketProviders.js');
const { resolveCryptoMonitorSettings, runCryptoPositionMonitor, createCryptoPositionMonitor, cryptoMonitorEnvironment } = await import('../src/paperPositionMonitor.js');
const { createMarketScanScheduler } = await import('../../new-bots/shared/marketBotRuntime.js');
const { recordProviderRequest } = await import('../src/providerTelemetry.js');
const { runForwardShadowPaper } = await import('../../new-bots/shared/forwardShadowPaper.js');
const { collectOperatorReport } = await import('../../new-bots/shared/operatorReport.js');
after(() => rm(directory, { recursive: true, force: true }));
const now = Date.parse('2026-10-03T15:00:00Z');
const id = (changes = {}) => ({ version: 1, namespace: 'coingecko', assetId: 'bitcoin', provider: 'Coinbase', pair: 'BTC-USD', base: 'BTC', quoteCurrency: 'USD',
  verificationSource: 'coingecko_tickers_complete', verifiedAt: new Date(now).toISOString(), ...changes });
const position = (changes = {}) => ({ orderId: 'position', owner: 'crypto', assetClass: 'crypto', instrumentKey: 'BTC', status: 'open', direction: 'long', units: 0.1, cryptoIdentity: id(), ...changes });
const book = (identity, time = now) => ({ provider: identity.provider, pair: identity.pair, base: identity.base, target: identity.quoteCurrency,
  bid: 100, ask: 100.1, observedAt: new Date(time).toISOString(), timestampBasis: 'provider_order_book', cryptoIdentity: identity,
  cryptoQuoteEvidence: coinbaseBookEvidence({ pair: identity.pair, bid: 100, ask: 100.1, time }) });
const options = { clock: () => now, env: {}, identityDirectory: join(directory, 'identities'),
  refreshIdentity: () => assert.fail('fresh identity must not fetch'), loadRules: async identity => cryptoRulesFixture({ ...identity, time: now }),
  loadCoinbaseBook: async identity => book(identity), collectKraken: () => assert.fail('no Kraken position') };

test('fresh position identity avoids refresh; expired evidence refreshes once and survives a new worker pass', async () => {
  let count = 0;
  const old = id({ verifiedAt: new Date(now - 70 * 60000).toISOString() }), cache = join(directory, 'cache');
  const refresh = async value => { count++; return { ...value, verifiedAt: new Date(now).toISOString() }; };
  assert.deepEqual(await loadPaperPositionIdentity(id(), { directory: cache, clock: () => now, refresh }), id());
  assert.equal(count, 0);
  await loadPaperPositionIdentity(old, { directory: cache, clock: () => now, refresh });
  const second = await loadPaperPositionIdentity(old, { directory: cache, clock: () => now + 1000, refresh });
  assert.equal(second.verifiedAt, new Date(now).toISOString()); assert.equal(count, 1);
  assert.equal((await readdir(cache)).length, 1);
  await assert.rejects(loadPaperPositionIdentity(old, { directory: cache, clock: () => now + 70 * 60000, refresh, allowRefresh: false }), { code: 'crypto_identity_refresh_deferred' });
});

test('cache cannot change identity, retimestamp expired evidence or invent USD conversion', async () => {
  const old = id({ verifiedAt: new Date(now - 70 * 60000).toISOString() });
  for (const wrong of [id({ assetId: 'wrong' }), old, id({ verifiedAt: new Date(now + 6000).toISOString() })]) {
    await assert.rejects(loadPaperPositionIdentity(old, { directory: join(directory, 'invalid-refresh'), clock: () => now, refresh: async () => wrong }), { code: 'crypto_identity_refresh_invalid' });
  }
  await assert.rejects(loadPaperPositionIdentity(id({ provider: 'Binance', pair: 'BTCUSDT', quoteCurrency: 'USDT' }), {
    directory, clock: () => now, refresh: () => assert.fail('conversion guard first') }), { code: 'crypto_quote_currency_conversion_required' });
  const cache = join(directory, 'cache'); const [name] = await readdir(cache);
  const saved = JSON.parse(await readFile(join(cache, name), 'utf8')); saved.identity.assetId = 'different';
  await writeFile(join(cache, name), JSON.stringify(saved));
  await assert.rejects(loadPaperPositionIdentity(old, { directory: cache, clock: () => now, refresh: () => assert.fail('tampered cache') }), { code: 'crypto_identity_cache_mismatch' });
});

test('same exact route across owned books shares requests; same ticker on different venues remains separate', async () => {
  let calls = 0;
  const out = await fetchCryptoPositionQuotes([position(), position({ orderId: 'shadow' })], { ...options,
    loadCoinbaseBook: async identity => { calls++; return book(identity); } });
  assert.equal(calls, 1); assert.equal(out.marks.length, 2); assert.equal(out.diagnostics.exactRoutes, 1);
  const krakenId = id({ provider: 'Kraken', pair: 'XBTUSD' });
  const mixed = await fetchCryptoPositionQuotes([position(), position({ orderId: 'kraken', cryptoIdentity: krakenId })], { ...options,
    collectKraken: async symbols => {
      assert.deepEqual(symbols, ['BTC/USD']);
      return { quotes: new Map([['BTC/USD', { symbol: 'BTC/USD', bid: 100, ask: 100.1, bidSize: 1, askSize: 1, time: new Date(now).toISOString(),
        cryptoQuoteEvidence: krakenBookEvidence({ bid: 100, ask: 100.1, time: now, bidSize: 1, askSize: 1 }) }]]), diagnostics: { status: 'complete', sessions: 1, durationMs: 5 } };
    } });
  assert.equal(mixed.marks.length, 2); assert.equal(mixed.marks.find(q => q.orderId === 'kraken').quote.cryptoIdentity.pair, 'XBTUSD');
  assert.equal(mixed.requestSummary.websocketSessions, 1);
});

test('native identity conflicts, legacy records and failed metadata produce no fabricated mark', async () => {
  const conflict = await fetchCryptoPositionQuotes([position(), position({ orderId: 'collision', cryptoIdentity: id({ assetId: 'another-bitcoin' }) }),
    position({ orderId: 'legacy', cryptoIdentity: undefined })], { ...options, loadRules: () => assert.fail('conflict before API') });
  assert.equal(conflict.marks.length, 0); assert.equal(conflict.diagnostics.rejectionReasons.conflicting_asset_ids_for_native_pair, 2);
  assert.equal(conflict.diagnostics.rejectionReasons.legacy_crypto_execution_identity_unavailable, 1);
  const failure = await fetchCryptoPositionQuotes([position()], { ...options, loadRules: () => { throw new Error('secret'); } });
  assert.equal(failure.diagnostics.rejectionReasons.crypto_product_metadata_unavailable, 1); assert.equal(JSON.stringify(failure).includes('secret'), false);
});

test('expired refresh leaves valid independent routes usable and stale collected quotes are discarded', async () => {
  let at = now;
  const result = await fetchCryptoPositionQuotes([position(), position({ orderId: 'old', cryptoIdentity: id({ assetId: 'ethereum', base: 'ETH', pair: 'ETH-USD', verifiedAt: new Date(now - 70 * 60000).toISOString() }) })],
    { ...options, identityDirectory: join(directory, 'outage'), refreshIdentity: async () => { throw new Error('offline'); } });
  assert.equal(result.marks.length, 1); assert.equal(result.diagnostics.rejectionReasons.crypto_identity_refresh_unavailable, 1);
  const stale = await fetchCryptoPositionQuotes([position()], { ...options, clock: () => at, loadCoinbaseBook: async identity => { at += 16000; return book(identity); } });
  assert.equal(stale.marks.length, 0); assert.equal(stale.diagnostics.rejectionReasons.crypto_quote_not_current_and_executable, 1);
});

test('Kraken current displayed side must cover each requested fill or liquidation quantity', async () => {
  const krakenId = id({ provider: 'Kraken', pair: 'XBTUSD' });
  const result = await fetchCryptoPositionQuotes([position({ cryptoIdentity: krakenId }), position({ orderId: 'pending', status: 'reserved', cryptoIdentity: krakenId })], {
    ...options, collectKraken: async () => ({ quotes: new Map([['BTC/USD', { symbol: 'BTC/USD', bid: 100, ask: 100.1, bidSize: 0.01, askSize: 1, time: new Date(now).toISOString(),
      cryptoQuoteEvidence: krakenBookEvidence({ bid: 100, ask: 100.1, time: now, bidSize: 0.01, askSize: 1 }) }]]), diagnostics: { status: 'complete', sessions: 1, durationMs: 1 } }) });
  assert.equal(result.marks.length, 1); assert.equal(result.marks[0].orderId, 'pending');
  assert.equal(result.diagnostics.rejectionReasons.insufficient_displayed_kraken_liquidity, 1);
});

test('identity refresh budget defers remaining stale routes without dropping already-current routes', async () => {
  let at = now, refreshed = 0;
  const rows = ['alpha', 'bravo', 'charlie'].map(name => position({ orderId: name,
    cryptoIdentity: id({ assetId: name, base: name.toUpperCase(), pair: `${name.toUpperCase()}-USD`, verifiedAt: new Date(now - 70 * 60000).toISOString() }) }));
  const result = await fetchCryptoPositionQuotes([...rows, position()], { ...options, clock: () => at,
    identityDirectory: join(directory, 'budget'), refreshIdentity: async value => { refreshed++; at += 90001; return { ...value, verifiedAt: new Date(at).toISOString() }; },
    loadRules: async value => cryptoRulesFixture({ ...value, time: at }), loadCoinbaseBook: async value => book(value, at) });
  assert.equal(refreshed, 1); assert.equal(result.marks.length, 2);
  assert.ok(result.marks.some(q => q.orderId === 'position'));
  assert.equal(result.diagnostics.rejectionReasons.crypto_identity_refresh_deferred, 2);
});

test('provider counters preserve HTTP attempts, failed retries and observed latency', async () => {
  const result = await fetchCryptoPositionQuotes([position()], { ...options,
    loadRules: async value => { recordProviderRequest('Coinbase', { status: 200, latencyMs: 5 }); return cryptoRulesFixture({ ...value, time: now }); },
    loadCoinbaseBook: async value => {
      recordProviderRequest('Coinbase', { status: 429, latencyMs: 3 });
      recordProviderRequest('Coinbase', { status: 200, latencyMs: 7 }); return book(value);
    } });
  assert.deepEqual(result.requestSummary, { attempts: 3, failures: 1, latencyMs: 15, httpAttempts: 3, websocketSessions: 0 });
});

const ticker = (changes = {}) => ({ symbol: 'BTC/USD', bid: 100, ask: 100.1, bid_qty: 1, ask_qty: 1, timestamp: new Date(now).toISOString(), ...changes });
function socketFixture(sendMessages) {
  let socket;
  return { connect: () => {
    socket = new EventEmitter(); socket.terminated = false; socket.terminate = () => { socket.terminated = true; socket.emit('close'); };
    socket.send = text => sendMessages(JSON.parse(text), payload => socket.emit('message', JSON.stringify(payload)), socket);
    queueMicrotask(() => socket.emit('open')); return socket;
  }, socket: () => socket };
}
test('Kraken requires provider timestamp, positive sizes and valid prices', () => {
  assert.ok(parseKrakenPositionQuote(ticker(), { now }));
  for (const change of [{ timestamp: null }, { timestamp: new Date(now - 15001).toISOString() }, { timestamp: new Date(now + 5001).toISOString() },
    { bid: true }, { ask: 99 }, { bid_qty: 0 }, { ask_qty: false }]) assert.equal(parseKrakenPositionQuote(ticker(change), { now }), null);
});

test('Kraken collector requires online status, exact acknowledgments and native timestamps; closes after success', async () => {
  const fixture = socketFixture((request, emit) => {
    assert.equal(request.params.event_trigger, 'bbo'); assert.deepEqual(request.params.symbol, ['BTC/USD']);
    emit({ channel: 'ticker', type: 'snapshot', data: [ticker()] }); // Cannot finish before ack/status.
    emit({ method: 'subscribe', req_id: request.req_id, success: true, result: { channel: 'ticker', symbol: 'BTC/USD' } });
    emit({ channel: 'status', data: [{ system: 'online' }] });
  });
  const result = await collectKrakenPositionQuotes(['BTC/USD', 'BTC/USD'], { connect: fixture.connect, clock: () => now });
  assert.equal(result.quotes.size, 1); assert.equal(result.diagnostics.acknowledged, 1); assert.equal(fixture.socket().terminated, true);
});

test('Kraken collector cannot substitute ack time, accept another pair, or use a disconnected stream', async () => {
  for (const mode of ['ack-only', 'wrong-pair', 'error', 'offline', 'no-ack', 'bad-json']) {
    const fixture = socketFixture((request, emit, socket) => {
      emit({ channel: 'status', data: [{ system: mode === 'offline' ? 'maintenance' : 'online' }] });
      if (mode !== 'no-ack') emit({ method: 'subscribe', req_id: request.req_id, success: true, time_out: new Date(now).toISOString(), result: { channel: 'ticker', symbol: 'BTC/USD' } });
      if (mode === 'wrong-pair') emit({ channel: 'ticker', type: 'update', data: [ticker({ symbol: 'ETH/USD' })] });
      if (mode === 'no-ack') emit({ channel: 'ticker', type: 'update', data: [ticker()] });
      if (mode === 'error') socket.emit('error', new Error('private'));
      if (mode === 'bad-json') socket.emit('message', '{');
    });
    const result = await collectKrakenPositionQuotes(['BTC/USD'], { connect: fixture.connect, clock: () => now, timeoutMs: 15 });
    assert.equal(result.quotes.size, 0); assert.equal(fixture.socket().terminated, true); assert.equal(JSON.stringify(result.diagnostics).includes('private'), false);
  }
});

test('Kraken subscription batching evaluates all requested symbols, including beyond the first fifty', async () => {
  const symbols = Array.from({ length: 103 }, (_, i) => `T${i}/USD`), sizes = [];
  const fixture = socketFixture((request, emit) => {
    sizes.push(request.params.symbol.length);
    emit({ channel: 'status', data: [{ system: 'online' }] });
    for (const symbol of request.params.symbol) {
      emit({ method: 'subscribe', req_id: request.req_id, success: true, result: { channel: 'ticker', symbol } });
      emit({ channel: 'ticker', type: 'snapshot', data: [ticker({ symbol })] });
    }
  });
  const result = await collectKrakenPositionQuotes(symbols, { connect: fixture.connect, clock: () => now });
  assert.deepEqual(sizes, [50, 50, 3]); assert.equal(result.quotes.size, 103); assert.equal(result.diagnostics.status, 'complete');
});

test('Kraken failed subscription retains independently verified symbols; collection aging cannot report complete', async () => {
  const fixture = socketFixture((request, emit) => {
    emit({ channel: 'status', data: [{ system: 'online' }] });
    emit({ method: 'subscribe', req_id: request.req_id, success: true, result: { channel: 'ticker', symbol: 'BTC/USD' } });
    emit({ channel: 'ticker', type: 'snapshot', data: [ticker()] });
    emit({ method: 'subscribe', req_id: request.req_id, success: false, result: { channel: 'ticker', symbol: 'ETH/USD' } });
  });
  const partial = await collectKrakenPositionQuotes(['BTC/USD', 'ETH/USD'], { connect: fixture.connect, clock: () => now });
  assert.equal(partial.quotes.size, 1); assert.equal(partial.diagnostics.subscriptionFailures, 1); assert.equal(partial.diagnostics.status, 'partial');
  let at = now;
  const slow = socketFixture((request, emit) => {
    emit({ channel: 'ticker', type: 'snapshot', data: [ticker()] });
    emit({ method: 'subscribe', req_id: request.req_id, success: true, result: { channel: 'ticker', symbol: 'BTC/USD' } });
    at += 15001;
    emit({ channel: 'status', data: [{ system: 'online' }] });
  });
  const stale = await collectKrakenPositionQuotes(['BTC/USD'], { connect: slow.connect, clock: () => at });
  assert.equal(stale.quotes.size, 0); assert.equal(stale.diagnostics.status, 'partial');
});

test('Crypto native adapter reaches the locked ledger and operator report, including later after-cost exit', async () => {
  const root = join(directory, 'lifecycle'); await mkdir(root);
  const statePath = join(root, 'ledger.json'); let at = now;
  const settings = { paperMonitor: { intervalSeconds: 60 }, sharedPaperStatePath: statePath, sharedPaperEmergencyStop: false,
    sharedPaperMaxQuoteAgeMs: 15000, sharedPaperMaxOpenMarkAgeMs: 300000, sharedPaperMaxSpreadPct: 0.5 };
  const pending = { ...position({ status: 'reserved' }), idempotencyKey: 'fixture', multiplier: 1, lotSize: 0.00000001,
    riskUsd: 1, notionalUsd: 10.01, marginRequirementUsd: 0, accountEquityUsd: 10000, entryPrice: 100.1, stopPrice: 98, targetPrice: 105,
    roundTripFeesPerUnit: 0.2, slippageReservePerUnit: 0.1, cryptoInstrumentRules: cryptoRulesFixture({ time: now }),
    quoteTime: new Date(now - 2000).toISOString(), reservedAt: new Date(now - 1000).toISOString(),
    entryExpiresAt: new Date(now + 600000).toISOString(), forceExitAt: new Date(now + 3600000).toISOString(),
    entryRiskPolicy: fillRiskPolicyFixture(), entryQuotePolicy: { maxQuoteAgeMs: 15000, maxSpreadPct: 0.5 }, sessionDate: '2026-10-03' };
  await writeFile(statePath, JSON.stringify({ schemaVersion: 1, orders: [pending], events: [] }));
  const run = () => runCryptoPositionMonitor({ settings, env: { OMNIMOD_LIVE_TRADING_ENABLED: 'false' }, directory: root, clock: () => at,
    shadowDirectories: [root], loadSettings: () => assert.fail('fresh identity needs no credentials'),
    fetchQuotes: rows => fetchCryptoPositionQuotes(rows, { ...options, clock: () => at,
      loadRules: async value => cryptoRulesFixture({ ...value, time: at }), loadCoinbaseBook: async value => {
        const bid = at === now ? 100 : 105.1, ask = at === now ? 100.1 : 105.2;
        return { ...book(value, at), bid, ask, cryptoQuoteEvidence: coinbaseBookEvidence({ pair: value.pair, bid, ask, time: at }) };
      } }) });
  assert.equal((await run()).counts.filled, 1);
  at += 1000;
  assert.equal((await run()).counts.closed, 1);
  const saved = JSON.parse(await readFile(statePath, 'utf8')).orders[0];
  assert.equal(saved.exitReason, 'target'); assert.ok(saved.realizedPnlUsd < saved.grossPnlUsd);
  assert.equal(saved.cryptoIdentity.assetId, 'bitcoin');
  const report = await collectOperatorReport({ rootDir: root, cryptoDataDir: root, stocksDataDir: join(root, 'stocks'), ledgerPath: statePath, now: at });
  assert.equal(report.bots.crypto.positionMonitor.counts.closed, 1);
  assert.equal(report.bots.crypto.positionMonitor.quoteAdapterVersion, 'crypto-owned-quotes-v2-native-book-evidence');
  assert.equal(report.bots.crypto.positionMonitor.freshness, 'fresh');
});

test('Crypto forward cohorts freeze the resolved monitor profile independently of process defaults', async () => {
  const input = { owner: 'crypto', strategyVersion: 'crypto-monitor-fixture-v1',
    profiles: [{ id: 'watch', overrides: { minScore: 65 }, hypothesis: 'Measure a fixed threshold.', changeMade: 'A fixed test threshold.', reason: 'Verify prospective cohorts.' }],
    allowlist: ['minScore'], baseConfig: {}, observations: [{ candidate: false }], evaluate: () => ({ status: 'no-setup', reasons: ['fixture'] }),
    stateDirectory: join(directory, 'cohorts'), accountEquity: 10000, riskPolicy: { emergencyStop: false }, sessionOpen: true };
  const disabled = (await runForwardShadowPaper({ ...input, now, monitoringEnv: { PAPER_MONITOR_INTERVAL_SECONDS: 0 } }))[0];
  const enabled = (await runForwardShadowPaper({ ...input, now: now + 1000, monitoringEnv: { PAPER_MONITOR_INTERVAL_SECONDS: 60 } }))[0];
  assert.notEqual(disabled.experimentHash, enabled.experimentHash);
  const manifest = JSON.parse(await readFile(enabled.manifest.manifestPath, 'utf8'));
  assert.equal(manifest.positionMonitoring.version, 'crypto-owned-quotes-v2-native-book-evidence');
  assert.equal(manifest.positionMonitoring.intervalSeconds, 60); assert.equal(enabled.counts.reservations, 0);
});

test('paper identity refresh uses exact complete provider evidence, never ticker-only fallback', async () => {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async input => {
    const url = new URL(input); calls.push(url.pathname);
    const payload = url.pathname.endsWith('/exchanges/list') ? [{ id: 'coinbase', name: 'Coinbase Exchange' }, { id: 'kraken', name: 'Kraken' }]
      : { tickers: [{ coin_id: 'test-identity-monitor', base: 'BTC', target: 'USD', market: { identifier: 'coinbase' }, is_stale: false, is_anomaly: false }] };
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(payload) };
  };
  try {
    const original = id({ assetId: 'test-identity-monitor', verifiedAt: new Date(Date.now() - 70 * 60000).toISOString() });
    const current = await refreshCryptoPaperIdentity(original, { coingeckoApiTier: 'demo', coingeckoApiKey: 'fixture-monitor' });
    assert.equal(current.assetId, original.assetId); assert.equal(current.pair, original.pair); assert.ok(Date.parse(current.verifiedAt) > Date.parse(original.verifiedAt));
    assert.equal(calls.length, 2);
    await assert.rejects(refreshCryptoPaperIdentity({ ...original, provider: 'Kraken', pair: 'XBTUSD' }, { coingeckoApiTier: 'demo', coingeckoApiKey: 'fixture-monitor' }), { code: 'crypto_pair_identity_not_verified' });
  } finally { globalThis.fetch = previous; }
});

test('identity settings allow deliberate public fallback but never invent a Pro credential or choose conflicting saved keys', async () => {
  const fallback = await resolveCryptoMonitorSettings({ settings: { coingeckoApiTier: 'demo' }, listGuilds: async () => [] });
  assert.equal(fallback.coingeckoApiTier, 'public');
  await assert.rejects(resolveCryptoMonitorSettings({ settings: { coingeckoApiTier: 'pro' }, listGuilds: async () => [] }), { code: 'crypto_identity_credentials_missing' });
  await assert.rejects(resolveCryptoMonitorSettings({ settings: { coingeckoApiTier: 'demo' }, listGuilds: async () => ['a', 'b'], loadGuild: async key => ({ coingeckoApiTier: 'demo', coingeckoApiKey: key }) }), { code: 'crypto_identity_credentials_ambiguous' });
  const monitor = createCryptoPositionMonitor({ settings: { paperMonitor: { intervalSeconds: 0 } }, schedulerFactory: () => assert.fail('disabled'), logFactory: () => assert.fail('disabled') });
  monitor.start(); await monitor.stop(); assert.equal(monitor.snapshot().enabled, false);
});

test('real isolated child runs idle and stops without credentials, Discord, market requests or real shadow ledgers', async () => {
  const root = join(directory, 'child'); await mkdir(root);
  const settings = { paperMonitor: { intervalSeconds: 60 }, sharedPaperStatePath: join(root, 'ledger.json'), sharedPaperEmergencyStop: true,
    sharedPaperMaxQuoteAgeMs: 15000, sharedPaperMaxOpenMarkAgeMs: 300000, sharedPaperMaxSpreadPct: 0.5, coingeckoApiTier: 'public', coingeckoApiKey: '' };
  assert.equal(cryptoMonitorEnvironment(settings, {}, root).OMNIMOD_EMERGENCY_STOP, 'true');
  const driver = join(root, 'monitor.mjs');
  await writeFile(driver, `import { runCryptoPositionMonitor } from ${JSON.stringify(new URL('../src/paperPositionMonitor.js', import.meta.url).href)};\nconst result=await runCryptoPositionMonitor({shadowDirectories:[process.env.OMNIMOD_CRYPTO_DATA_DIR]});\nif(result.status!=='idle')process.exitCode=2;\n`);
  let resolve; const completed = new Promise(r => { resolve = r; });
  const monitor = createCryptoPositionMonitor({ settings, env: { ...process.env, OMNIMOD_LIVE_TRADING_ENABLED: 'false' }, dataDirectory: root,
    schedulerFactory: options => createMarketScanScheduler({ ...options, entry: driver }),
    onState: state => { if (state.lastScanFinishedAt) resolve(state); } });
  let timer;
  try {
    monitor.start();
    const out = await Promise.race([completed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Child timeout')), 10000); })]);
    assert.equal(out.lastScanExitCode, 0);
    const report = JSON.parse(await readFile(join(root, 'paper-position-monitor.json'), 'utf8'));
    assert.equal(report.provider.requestAttempts, 0); assert.equal(report.status, 'idle');
    await assert.rejects(readFile(settings.sharedPaperStatePath), { code: 'ENOENT' });
  } finally { clearTimeout(timer); await monitor.stop(); }
});
