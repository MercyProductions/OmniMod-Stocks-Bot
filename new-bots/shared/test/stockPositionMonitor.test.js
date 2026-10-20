import { fillRiskPolicyFixture } from '../fixtures/fillRiskPolicy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPaperPositionMonitor } from '../paperPositionMonitor.js';
import { loadMarketPositionQuotes } from '../marketPositionQuotes.js';
import { readPaperRiskLedger } from '../paperRisk.js';
import { fetchStockPositionQuotes, stockMarkSessionOpen } from '../stockPositionQuotes.js';
import { runForwardShadowPaper } from '../forwardShadowPaper.js';
import { collectOperatorReport } from '../operatorReport.js';
import { savePaperPositionMonitorReport } from '../paperPositionMonitor.js';

const initial = Date.parse('2026-10-02T15:00:00Z');
const order = (extra = {}) => ({ orderId: 'stock', idempotencyKey: 'stock', owner: 'stocks', assetClass: 'stock',
  instrumentKey: 'AAPL', status: 'reserved', direction: 'long', units: 10, multiplier: 1,
  riskUsd: 12, notionalUsd: 1001, marginRequirementUsd: 0, accountEquityUsd: 10000,
  entryPrice: 100.1, stopPrice: 99, targetPrice: 102, roundTripFeesPerUnit: 0.02, slippageReservePerUnit: 0.03,
  quoteTime: new Date(initial - 2000).toISOString(), reservedAt: new Date(initial - 1000).toISOString(),
  forceExitAt: new Date(initial + 3600000).toISOString(), entryExpiresAt: new Date(initial + 600000).toISOString(),
  sessionDate: '2026-10-02', entryRiskPolicy: fillRiskPolicyFixture(), entryQuotePolicy: { maxQuoteAgeMs: 5000, maxSpreadPct: 0.2 }, ...extra });
const save = (path, orders) => writeFile(path, JSON.stringify({ schemaVersion: 1, orders, events: [] }));
async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-stock-monitor-'));
  const statePath = join(directory, 'production.json'), shadow = join(directory, 'shadow');
  await mkdir(shadow);
  const env = { TRADING_RISK_STATE_PATH: statePath, OMNIMOD_EMERGENCY_STOP: 'false', ALPACA_DATA_FEED: 'iex',
    ALPACA_API_KEY_ID: 'fixture-key', ALPACA_API_SECRET_KEY: 'fixture-secret' };
  const run = (extra = {}) => runPaperPositionMonitor({ bot: 'stocks', env, clock: () => initial, shadowDirectories: [shadow], ...extra });
  try { await fn({ directory, statePath, shadow, env, run }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
function provider({ clock = () => initial, prices = () => ({ bp: 100, ap: 100.1 }), feed = 'iex', clockBody,
  calendar = [{ date: '2026-10-02', open: '09:30', close: '16:00' }], calls = [], delay = () => {} } = {}) {
  return async (input, options) => {
    const url = new URL(input); calls.push(url.pathname);
    assert.ok(!options.method || options.method === 'GET');
    let body;
    if (url.pathname === '/v2/clock') body = clockBody ?? { is_open: true, timestamp: new Date(clock()).toISOString() };
    else if (url.pathname === '/v2/calendar') body = calendar;
    else {
      assert.equal(url.hostname, 'data.alpaca.markets');
      assert.equal(url.pathname, '/v2/stocks/quotes/latest');
      assert.equal(url.searchParams.get('feed'), feed);
      const symbols = url.searchParams.get('symbols').split(',');
      assert.ok(symbols.length <= 100);
      body = { quotes: Object.fromEntries(symbols.map(symbol => [symbol, { t: new Date(clock()).toISOString(), bs: 10000, as: 10000, bx: feed === 'iex' ? 'V' : 'Q', ax: feed === 'iex' ? 'V' : 'Q', z: 'C', c: ['R'], ...prices(symbol) }])) };
      delay();
    }
    return { ok: true, status: 200, headers: new Headers(), json: async () => body };
  };
}

test('Stocks quote-only monitor fills and later closes production and older shadow books outside the scan shortlist', () => fixture(async ({ statePath, shadow, run }) => {
  await save(statePath, [order(), order({ owner: 'crypto', assetClass: 'crypto', orderId: 'other', instrumentKey: 'BTC' })]);
  const oldBook = join(shadow, 'stocks-old-profile-1234567890abcdef.json');
  await save(oldBook, [order()]); // Same imported UUID must remain book-scoped.
  let at = initial, bid = 100; const calls = [];
  const fetcher = provider({ clock: () => at, prices: () => ({ bp: bid, ap: bid + 0.1 }), calls });
  const opts = { clock: () => at, fetchMarks: (bot, positions, options) => loadMarketPositionQuotes(bot, positions, { ...options, fetcher }) };
  const first = await run(opts);
  assert.equal(first.counts.filled, 2); assert.equal(first.provider.requestAttempts, 3);
  assert.equal(calls.filter(p => p.endsWith('/latest')).length, 1);
  at += 1000; bid = 102.1;
  const second = await run(opts); assert.equal(second.counts.closed, 2);
  const primary = await readPaperRiskLedger({ statePath });
  assert.equal(primary.orders[0].exitReason, 'target'); assert.equal(primary.orders[1].status, 'reserved');
  assert.equal((await readPaperRiskLedger({ statePath: oldBook })).orders[0].status, 'closed');
}));

test('Stocks idle monitor does not fetch providers or create a ledger', () => fixture(async ({ statePath, run }) => {
  const result = await run({ fetchMarks: () => assert.fail('no provider work without active orders') });
  assert.equal(result.status, 'idle'); assert.equal(result.counts.activeBeforeQuotes, 0);
  await assert.rejects(readFile(statePath), { code: 'ENOENT' });
}));

test('Stocks monitor preserves emergency cancellation ownership and refuses stale exit prices', () => fixture(async ({ statePath, env, run }) => {
  await save(statePath, [order(), order({ orderId: 'open', status: 'open', fillPrice: 100.1, filledAt: new Date(initial - 1000).toISOString() }),
    order({ orderId: 'other', owner: 'crypto', assetClass: 'crypto' })]);
  const result = await run({ env: { ...env, OMNIMOD_EMERGENCY_STOP: 'true' }, fetchMarks: (bot, rows, options) =>
    loadMarketPositionQuotes(bot, rows, { ...options, fetcher: provider({ prices: () => ({ bp: 100, ap: 100.1, t: new Date(initial - 60000).toISOString() }) }) }) });
  assert.equal(result.counts.cancelled, 1); assert.equal(result.counts.closed, 0); assert.equal(result.counts.quotesMissing, 1);
  assert.equal(result.provider.rejectionReasons.stale_or_future_quote, 1);
  const book = await readPaperRiskLedger({ statePath });
  assert.equal(book.orders[1].status, 'open'); assert.equal(book.orders[2].status, 'reserved');
}));

test('all owned symbols are batched and deduplicated, never truncated to a watchlist', async () => {
  const orders = Array.from({ length: 205 }, (_, i) => order({ orderId: `order-${i}`, instrumentKey: `S${i}` }));
  orders.push(order({ orderId: 'same-symbol', instrumentKey: 'S0' }));
  const calls = [];
  const result = await fetchStockPositionQuotes(orders, { env: { ALPACA_DATA_FEED: 'sip', ALPACA_API_KEY_ID: 'fixture', ALPACA_API_SECRET_KEY: 'secret' },
    clock: () => initial, fetcher: provider({ feed: 'sip', calls }) });
  assert.equal(result.marks.length, 206); assert.equal(result.diagnostics.symbolsRequested, 205);
  assert.equal(calls.filter(p => p.endsWith('/latest')).length, 3); assert.equal(result.diagnostics.quoteCoverage, 'consolidated');
});

test('delayed or unsupported feeds and missing credentials make no requests', async () => {
  for (const env of [{}, { ALPACA_DATA_FEED: 'delayed_sip' }, { ALPACA_DATA_FEED: 'bogus' }]) {
    const result = await fetchStockPositionQuotes([order()], { env, fetcher: () => assert.fail('must not fetch') });
    assert.equal(result.marks.length, 0); assert.ok(result.diagnostics.rejectionReasons);
  }
});

test('Stocks owned monitor reports missing size, nonregular conditions and symbol mismatches instead of fabricating fills', () => fixture(async ({ statePath, run }) => {
  await save(statePath, [order()]);
  const before = await readFile(statePath, 'utf8');
  for (const [extra, reason] of [
    [{ as: 0 }, 'stock_quote_evidence_required'], [{ c: ['N'] }, 'stock_quote_condition_not_regular'],
    [{ S: 'MSFT' }, 'stock_quote_symbol_mismatch'],
  ]) {
    const result = await run({ fetchMarks: (bot, positions, options) => loadMarketPositionQuotes(bot, positions,
      { ...options, fetcher: provider({ prices: () => ({ bp: 100, ap: 100.1, ...extra }) }) }) });
    assert.equal(result.counts.filled, 0); assert.equal(result.provider.rejectionReasons[reason], 1);
    assert.equal(await readFile(statePath, 'utf8'), before);
  }
}));

test('slow later batches cannot revive earlier quotes or stale market-clock evidence', async () => {
  const rows = Array.from({ length: 101 }, (_, i) => order({ orderId: String(i), instrumentKey: `S${i}` }));
  for (const elapsed of [16000, 31000]) {
    let at = initial, batches = 0;
    const fetcher = provider({ clock: () => at });
    const result = await fetchStockPositionQuotes(rows, { env: { ALPACA_API_KEY_ID: 'fixture', ALPACA_API_SECRET_KEY: 'secret' },
      clock: () => at, fetcher: (url, options) => {
        if (new URL(url).pathname.endsWith('/latest') && ++batches === 2) at += elapsed;
        return fetcher(url, options);
      } });
    assert.equal(result.marks.length, elapsed === 16000 ? 1 : 0);
    assert.equal(result.diagnostics.rejectionReasons[elapsed === 16000 ? 'quote_aged_during_collection' : 'market_clock_aged_during_collection'], elapsed === 16000 ? 100 : 101);
  }
});

test('invalid market session evidence is rejected before requesting quotes', async () => {
  for (const options of [
    { calendar: [] }, { calendar: [{ date: '2026-10-02', open: '09:30', close: '09:00' }] },
    { calendar: [{ date: '2026-10-02', open: '09:30', close: '25:00' }] },
    { clockBody: { is_open: 'true', timestamp: new Date(initial).toISOString() } },
    { clockBody: { is_open: true, timestamp: new Date(initial - 31000).toISOString() } },
    { clockBody: { is_open: true, timestamp: new Date(initial + 6000).toISOString() } },
  ]) {
    const calls = [];
    const result = await fetchStockPositionQuotes([order()], { env: { ALPACA_API_KEY_ID: 'fixture', ALPACA_API_SECRET_KEY: 'secret' },
      clock: () => initial, fetcher: provider({ ...options, calls }) });
    assert.equal(result.marks.length, 0); assert.equal(calls.length, 2);
  }
});

test('native malformed, crossed, future and stale prices remain explicit rejections', async () => {
  for (const [prices, reason] of [[{ bp: true, ap: 100 }, 'invalid_bid_ask'], [{ bp: 101, ap: 100 }, 'invalid_bid_ask'],
    [{ bp: 100, ap: 100.1, t: new Date(initial + 6000).toISOString() }, 'stale_or_future_quote'],
    [{ bp: 100, ap: 100.1, t: new Date(initial - 15001).toISOString() }, 'stale_or_future_quote']]) {
    const result = await fetchStockPositionQuotes([order()], { env: { ALPACA_API_KEY_ID: 'fixture', ALPACA_API_SECRET_KEY: 'secret' },
      clock: () => initial, fetcher: provider({ prices: () => prices }) });
    assert.equal(result.marks.length, 0); assert.equal(result.diagnostics.rejectionReasons[reason], 1);
  }
});

test('a failing quote batch does not discard independent successful batches or leak provider content', async () => {
  const rows = Array.from({ length: 101 }, (_, i) => order({ orderId: String(i), instrumentKey: `S${i}` }));
  const fetcher = provider(); let batches = 0; const metrics = [];
  const result = await fetchStockPositionQuotes(rows, { env: { ALPACA_API_KEY_ID: 'fixture', ALPACA_API_SECRET_KEY: 'secret' },
    providerMetrics: metrics, clock: () => initial, fetcher: (input, options) => {
      if (new URL(input).pathname.endsWith('/latest') && ++batches === 1)
        return { ok: false, status: 403, headers: new Headers(), json: () => ({ secret: 'never disclose' }) };
      return fetcher(input, options);
    } });
  assert.equal(result.marks.length, 1); assert.equal(result.diagnostics.rejectionReasons.quote_provider_failure, 100);
  assert.equal(metrics.filter(m => m.status === 403).length, 1);
  assert.equal(JSON.stringify(result).includes('never disclose'), false);
});

test('regular-session entry permission is rechecked at close while existing positions retain fresh exit marks', () => fixture(async ({ statePath, env, run }) => {
  const at = Date.parse('2026-10-02T20:00:01Z');
  const pending = order({ forceExitAt: new Date(at + 60000).toISOString(), entryExpiresAt: new Date(at + 60000).toISOString() });
  const open = { ...pending, orderId: 'open', status: 'open', fillPrice: 100.1, filledAt: new Date(at - 10000).toISOString() };
  await save(statePath, [pending, open]);
  const report = await run({ clock: () => at, fetchMarks: (bot, rows, options) => loadMarketPositionQuotes(bot, rows,
    { ...options, fetcher: provider({ clock: () => at, prices: () => ({ bp: 102.1, ap: 102.2 }), clockBody: { is_open: false, timestamp: new Date(at).toISOString() } }) }) });
  assert.equal(report.counts.filled, 0); assert.equal(report.counts.closed, 1);
  assert.equal(report.rejectionReasons.entry_session_closed, 1);
  assert.equal((await readPaperRiskLedger({ statePath })).orders[0].status, 'reserved');
  const mark = { quote: { time: new Date(at - 2000).toISOString() }, stockSession: { isOpen: true,
    openTime: initial - 3600000, closeTime: at - 1000, clockTime: at - 2000 } };
  assert.equal(stockMarkSessionOpen(mark, at - 2000), true);
  assert.equal(stockMarkSessionOpen(mark, at), false);
}));

test('Stocks duplicate and unrequested marks cannot mutate a ledger', () => fixture(async ({ statePath, run }) => {
  await save(statePath, [order()]); const before = await readFile(statePath, 'utf8');
  const report = await run({ fetchMarks: async (_bot, rows) => ({ marks: [
    { orderId: rows[0].orderId }, { orderId: rows[0].orderId }, { orderId: 'foreign' },
  ] }) });
  assert.equal(report.counts.duplicateMarks, 2); assert.equal(report.counts.unexpectedMarks, 1);
  assert.equal(report.counts.quotesProcessed, 0); assert.equal(await readFile(statePath, 'utf8'), before);
}));

test('resolved local Stocks cadence and feed isolate future experiments without relying on process environment', () => fixture(async ({ shadow }) => {
  const input = { owner: 'stocks', strategyVersion: 'stock-monitor-test-v1',
    profiles: [{ id: 'baseline', overrides: { stopScale: 1 }, hypothesis: 'Measure later quote outcomes.', changeMade: 'Keep frozen levels.', reason: 'Prospective fixture.' }],
    allowlist: ['stopScale'], observations: [{ candidate: false }], evaluate: () => ({ status: 'no-setup', reasons: ['fixture'] }),
    stateDirectory: shadow, accountEquity: 10000, riskPolicy: { emergencyStop: false }, sessionOpen: true };
  const a = (await runForwardShadowPaper({ ...input, now: initial, baseConfig: { executionFeed: 'iex' }, monitoringEnv: { PAPER_MONITOR_INTERVAL_SECONDS: 0 } }))[0];
  const b = (await runForwardShadowPaper({ ...input, now: initial + 1000, baseConfig: { executionFeed: 'iex' }, monitoringEnv: { PAPER_MONITOR_INTERVAL_SECONDS: 60 } }))[0];
  const c = (await runForwardShadowPaper({ ...input, now: initial + 2000, baseConfig: { executionFeed: 'sip' }, monitoringEnv: { PAPER_MONITOR_INTERVAL_SECONDS: 60 } }))[0];
  assert.equal(new Set([a.experimentHash, b.experimentHash, c.experimentHash]).size, 3);
  const manifest = JSON.parse(await readFile(b.manifest.manifestPath, 'utf8'));
  assert.equal(manifest.positionMonitoring.intervalSeconds, 60);
  assert.equal(manifest.positionMonitoring.version, 'stock-owned-quotes-v2-native-evidence');
  assert.equal(b.counts.reservations, 0);
}));

test('six-market operator report displays independent Stocks monitoring separately from discovery', () => fixture(async ({ directory, statePath, run }) => {
  const report = await run({ fetchMarks: () => assert.fail('idle') });
  await savePaperPositionMonitorReport(report, directory);
  const diagnostics = join(directory, 'research', 'diagnostics');
  await mkdir(diagnostics, { recursive: true });
  const quoteEvidence = { evaluated: 3, executableQuotes: 1, rejected: 2, feed: 'iex',
    rejectionReasons: { stock_quote_evidence_required: 1, stale_or_future_quote: 1 } };
  await writeFile(join(diagnostics, '2026-10-02.jsonl'), JSON.stringify({ recordType: 'scan_diagnostic',
    guildId: 'fixture', startedAt: new Date(initial).toISOString(), sharedPaperQuoteEvidence: quoteEvidence,
    sharedPaperMarkDiagnostics: { quoteRejected: 2 } }) + '\n');
  const operator = await collectOperatorReport({ rootDir: directory, stocksDataDir: directory, cryptoDataDir: join(directory, 'crypto'),
    ledgerPath: statePath, now: initial });
  assert.equal(operator.bots.stocks.positionMonitor.status, 'idle');
  assert.equal(operator.bots.stocks.positionMonitor.provider.requestAttempts, 0);
  assert.equal(operator.bots.stocks.positionMonitor.freshness, 'fresh');
  assert.deepEqual(operator.bots.stocks.sharedPaperQuoteEvidence, [quoteEvidence]);
  assert.deepEqual(operator.bots.stocks.sharedPaperMarkDiagnostics, [{ quoteRejected: 2 }]);
}));
