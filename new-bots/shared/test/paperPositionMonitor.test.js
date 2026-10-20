import { fillRiskPolicyFixture } from '../fixtures/fillRiskPolicy.js';
import { stockQuote } from '../fixtures/stockQuoteEvidence.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPaperPositionMonitor, savePaperPositionMonitorReport, readPaperPositionMonitorReport } from '../paperPositionMonitor.js';
import { loadMarketPositionQuotes } from '../marketPositionQuotes.js';
import { paperMonitorProfile } from '../paperMonitorConfig.js';
import { readPaperRiskLedger } from '../paperRisk.js';

const now = Date.parse('2026-10-02T15:00:00Z');
const quote = (at = now, prices = {}) => stockQuote('SPY', { bid: 100, ask: 100.1, time: new Date(at).toISOString(), quality: 'executable', ...prices });
const order = (overrides = {}) => ({ orderId: 'owned', idempotencyKey: 'owned', owner: 'etfs-etps', assetClass: 'etf',
  instrumentKey: 'SPY', status: 'open', direction: 'long', units: 1, multiplier: 1,
  riskUsd: 1, notionalUsd: 100, marginRequirementUsd: 0, accountEquityUsd: 10000,
  entryPrice: 100.1, fillPrice: 100.1, stopPrice: 99, targetPrice: 102, roundTripFeesPerUnit: 0.02, slippageReservePerUnit: 0.03,
  quoteTime: new Date(now - 2000).toISOString(), filledAt: new Date(now - 1000).toISOString(),
  forceExitAt: new Date(now + 3600000).toISOString(), sessionDate: '2026-10-02',
  entryRiskPolicy: fillRiskPolicyFixture(), entryQuotePolicy: { maxQuoteAgeMs: 5000, maxSpreadPct: 0.2 }, ...overrides });
const save = (path, orders) => writeFile(path, JSON.stringify({ schemaVersion: 1, orders, events: [] }));
async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-position-monitor-'));
  const statePath = join(directory, 'production.json'), shadow = join(directory, 'shadow');
  await mkdir(shadow);
  const env = { TRADING_RISK_STATE_PATH: statePath, OMNIMOD_EMERGENCY_STOP: 'false', OMNIMOD_LIVE_TRADING_ENABLED: 'false' };
  const run = (extra = {}) => runPaperPositionMonitor({ bot: 'etfs-etps', env, shadowDirectories: [shadow], clock: () => now, ...extra });
  try { await fn({ directory, statePath, shadow, env, run }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('empty position monitor performs no provider work and creates no ledger or experiments', () => fixture(async ({ statePath, run }) => {
  for (const bot of ['forex', 'futures', 'options', 'etfs-etps']) {
    const report = await run({ bot, fetchMarks: () => { throw new Error('must not fetch'); } });
    assert.equal(report.status, 'idle'); assert.equal(report.provider.requestAttempts, 0);
    assert.equal(report.counts.activeBeforeQuotes, 0);
  }
  await assert.rejects(readFile(statePath), { code: 'ENOENT' });
}));

test('position monitor exposes shared-budget deferrals without inventing HTTP failures', () => fixture(async ({ statePath, run }) => {
  await save(statePath, [order()]);
  const report = await run({ fetchMarks: async (_bot, _orders, { providerMetrics }) => {
    providerMetrics.push({ status: 0, latencyMs: 500, requestAttempted: false, budgetRejection: 'ALPACA_PACING_DEFERRED' });
    return { marks: [], diagnostics: { status: 'budget_deferred' } };
  } });
  assert.equal(report.provider.requestAttempts, 0); assert.equal(report.provider.failures, 0);
  assert.equal(report.provider.budgetDeferrals, 1); assert.equal(report.provider.latencyMs, 0);
  assert.equal(report.status, 'degraded'); assert.equal(report.counts.quotesMissing, 1);
}));

test('production and old shadow positions are monitored separately after leaving every shortlist', () => fixture(async ({ statePath, shadow, run }) => {
  const shadowPath = join(shadow, 'etfs-etps-old-profile-1234567890abcdef.json');
  await save(statePath, [order(), order({ orderId: 'other-owner', owner: 'stocks', assetClass: 'stock', instrumentKey: 'MSFT' })]);
  await save(shadowPath, [order()]); // Same imported ID must not collide between books.
  await writeFile(join(shadow, 'etfs-etps-old-profile-1234567890abcdef.experiment.json'), 'null');
  let requested;
  const report = await run({ fetchMarks: async (bot, orders) => {
    assert.equal(bot, 'etfs-etps'); requested = orders;
    return { diagnostics: { status: 'complete' }, marks: orders.map((o, i) => ({ orderId: o.orderId,
      quote: quote(now, { bid: i ? 102.5 : 100.2, ask: i ? 102.6 : 100.3 }), sessionOpen: true })) };
  } });
  assert.equal(requested.length, 2); assert.equal(new Set(requested.map((o) => o.orderId)).size, 2);
  assert.equal(report.counts.marked, 1); assert.equal(report.counts.closed, 1);
  const primary = await readPaperRiskLedger({ statePath });
  assert.equal(primary.orders[0].status, 'open'); assert.equal(primary.orders[1].markedAt, undefined);
  assert.equal((await readPaperRiskLedger({ statePath: shadowPath })).orders[0].status, 'closed');
}));

test('Options monitor includes independent research ledgers without touching another bot', () => fixture(async ({ statePath, shadow, run }) => {
  await mkdir(join(shadow, 'options-independent'));
  const independent = join(shadow, 'options-independent/options-independent-1234567890abcdef.json');
  await save(independent, [order({ owner: 'options', assetClass: 'option' })]);
  await save(statePath, [order({ status: 'reserved' })]);
  const original = await readFile(statePath, 'utf8');
  const report = await run({ bot: 'options', fetchMarks: async (_bot, orders) => {
    assert.equal(orders.length, 1);
    return { marks: orders.map((o) => ({ orderId: o.orderId, quote: quote(), sessionOpen: true })) };
  } });
  assert.equal(report.counts.marked, 1); assert.equal(await readFile(statePath, 'utf8'), original);
}));

test('stop cancels only owned reservations and still obtains executable exits for owned open positions', () => fixture(async ({ statePath, env, run }) => {
  await save(statePath, [order(), order({ orderId: 'pending', status: 'reserved' }),
    order({ orderId: 'other', owner: 'forex', assetClass: 'forex', status: 'reserved' })]);
  const report = await run({ env: { ...env, OMNIMOD_EMERGENCY_STOP: 'true' }, fetchMarks: async (_bot, orders) => {
    assert.equal(orders.length, 1);
    return { marks: [{ orderId: orders[0].orderId, quote: quote(), sessionOpen: false }] };
  } });
  assert.equal(report.counts.cancelled, 1); assert.equal(report.counts.closed, 1);
  const ledger = await readPaperRiskLedger({ statePath });
  assert.equal(ledger.orders[0].exitReason, 'emergency_stop'); assert.equal(ledger.orders[2].status, 'reserved');
}));

test('provider outage, duplicates and foreign marks cannot close or overwrite an existing position', () => fixture(async ({ statePath, run }) => {
  await save(statePath, [order()]); const before = await readFile(statePath, 'utf8');
  const failed = await run({ fetchMarks: () => { throw new Error('TOKEN never log this provider payload'); } });
  assert.equal(failed.status, 'degraded'); assert.equal(failed.counts.quotesMissing, 1);
  assert.equal(JSON.stringify(failed).includes('TOKEN'), false);
  const duplicates = await run({ fetchMarks: async (_bot, orders) => ({ marks: [
    ...[1, 2].map(() => ({ orderId: orders[0].orderId, quote: quote(), sessionOpen: true })),
    { orderId: 'unrequested', quote: quote(), sessionOpen: true },
  ] }) });
  assert.equal(duplicates.counts.duplicateMarks, 2); assert.equal(duplicates.counts.unexpectedMarks, 1);
  assert.equal(duplicates.counts.quotesProcessed, 0); assert.equal(await readFile(statePath, 'utf8'), before);
}));

test('provider latency is rechecked before marking and expired reservations cancel without a price', () => fixture(async ({ statePath, run }) => {
  await save(statePath, [order(), order({ orderId: 'expired', status: 'reserved', entryExpiresAt: new Date(now - 1).toISOString() })]);
  let at = now;
  const report = await run({ clock: () => at, fetchMarks: async (_bot, orders) => {
    at += 20000; return { marks: orders.map((o) => ({ orderId: o.orderId, quote: quote(), sessionOpen: true })) };
  } });
  assert.equal(report.counts.cancelled, 1); assert.equal(report.counts.rejected, 1);
  assert.equal(report.rejectionReasons.quote_not_current_and_executable, 1);
  assert.equal((await readPaperRiskLedger({ statePath })).orders[0].markedAt, undefined);
}));

test('native Alpaca mark responses can fill then close a paper reservation without discovery, bars or messages', () => fixture(async ({ statePath, env, run }) => {
  await save(statePath, [order({ status: 'reserved', fillPrice: undefined, filledAt: undefined })]);
  let at = now, bid = 100, ask = 100.1; const calls = [];
  const fetcher = async (input, options) => {
    const url = new URL(input); calls.push(url.pathname);
    assert.ok(!options.method || options.method === 'GET');
    const body = url.pathname.endsWith('/clock') ? { is_open: true, timestamp: new Date(at).toISOString() }
      : url.pathname.endsWith('/calendar') ? [{ date: '2026-10-02', open: '09:30', close: '16:00' }]
      : url.pathname.endsWith('/snapshots') ? { snapshots: { SPY: { latestQuote: { bs: 100000, as: 100000, bx: 'P', ax: 'P', z: 'B', c: ['R'], t: new Date(at).toISOString(), bp: bid, ap: ask } } } }
      : null;
    assert.ok(body, 'unexpected endpoint'); return { ok: true, status: 200, headers: new Headers(), json: async () => body };
  };
  const opts = { env: { ...env, ETF_SOURCE: 'alpaca', ETF_ALPACA_FEED: 'sip', ALPACA_API_KEY_ID: 'fixture', ALPACA_API_SECRET_KEY: 'fixture' },
    clock: () => at, fetchMarks: (bot, orders, options) => loadMarketPositionQuotes(bot, orders, { ...options, fetcher }) };
  const first = await run(opts); assert.equal(first.counts.filled, 1); assert.equal(first.provider.requestAttempts, 3);
  at += 1000; bid = 102.1; ask = 102.2;
  const second = await run(opts); assert.equal(second.counts.closed, 1);
  assert.equal((await readPaperRiskLedger({ statePath })).orders[0].exitReason, 'target');
  assert.equal(calls.length, 6);
}));

test('native OANDA monitoring uses only account pricing and reuses the existing FX quote validator', async () => {
  let count = 0;
  const result = await loadMarketPositionQuotes('forex', [order({ owner: 'forex', assetClass: 'forex', instrumentKey: 'EUR_USD' })],
    { env: { FOREX_SOURCE: 'oanda-practice', OANDA_ENV: 'practice', OANDA_ACCOUNT_ID: 'fixture', OANDA_API_TOKEN: 'test' },
      clock: () => now, fetcher: async (input) => {
        count++; const url = new URL(input); assert.equal(url.hostname, 'api-fxpractice.oanda.com');
        assert.equal(url.pathname, '/v3/accounts/fixture/pricing'); assert.equal(url.searchParams.get('instruments'), 'EUR_USD');
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ prices: [{ instrument: 'EUR_USD', time: new Date(now).toISOString(),
          status: 'tradeable', tradeable: true, bids: [{ price: '1.1', liquidity: 1000 }], asks: [{ price: '1.1001', liquidity: 1000 }] }] }) };
      } });
  assert.equal(count, 1); assert.equal(result.marks.length, 1); assert.equal(result.marks[0].sessionOpen, true);
  assert.equal(result.marks[0].quote.quality, 'executable');
});

test('unconfigured and delayed sources remain non-executable without requests', async () => {
  const fetcher = () => { throw new Error('no network expected'); };
  for (const [bot, env, expected] of [
    ['forex', {}, 'source_not_configured'], ['forex', { FOREX_SOURCE: 'oanda-practice' }, 'credentials_missing'],
    ['futures', {}, 'source_not_configured'], ['futures', { FUTURES_POSITION_MARK_SOURCE: 'databento-live' }, 'credentials_missing'],
    ['options', { TRADIER_ENV: 'sandbox' }, 'sandbox_data_is_delayed'],
    ['etfs-etps', { ETF_SOURCE: 'alpaca', ETF_ALPACA_FEED: 'iex' }, 'consolidated_sip_required_for_position_marks'],
  ]) {
    const assetClass = { forex: 'forex', futures: 'future', options: 'option', 'etfs-etps': 'etf' }[bot];
    const result = await loadMarketPositionQuotes(bot, [order({ owner: bot, assetClass })], { env, fetcher, clock: () => now });
    assert.equal(result.diagnostics.status, expected); assert.equal(result.marks.length, 0);
  }
});

test('monitor reports expose stale state and unreadable ledgers without claiming an empty healthy book', () => fixture(async ({ directory, statePath, run }) => {
  await writeFile(statePath, 'broken JSON');
  const report = await run(); assert.equal(report.status, 'degraded'); assert.equal(report.issues[0].code, 'read_or_recovery_failed');
  await savePaperPositionMonitorReport(report, directory);
  assert.equal((await readPaperPositionMonitorReport('etfs-etps', directory, now + 100)).freshness, 'fresh');
  assert.equal((await readPaperPositionMonitorReport('etfs-etps', directory, now + 600000)).freshness, 'stale');
  assert.equal((await readPaperPositionMonitorReport('forex', directory, now)).status, 'invalid');
}));

test('monitor configuration is opt-in and rate-bounded', () => {
  assert.equal(paperMonitorProfile({}).enabled, false);
  assert.equal(paperMonitorProfile({ PAPER_MONITOR_INTERVAL_SECONDS: '60' }).enabled, true);
  for (const value of ['59', '-1', 'NaN', '900.5', '901']) assert.throws(() => paperMonitorProfile({ PAPER_MONITOR_INTERVAL_SECONDS: value }));
});

test('ambiguous order IDs inside a ledger cannot route a quote or cancellation to a different owner', () => fixture(async ({ statePath, env, run }) => {
  await save(statePath, [order({ owner: 'stocks', assetClass: 'stock', status: 'reserved' }), order({ status: 'reserved' })]);
  const before = await readFile(statePath, 'utf8');
  const report = await run({ env: { ...env, OMNIMOD_EMERGENCY_STOP: 'true' }, fetchMarks: () => { throw new Error('must not request'); } });
  assert.equal(report.status, 'degraded'); assert.equal(report.issues[0].code, 'ambiguous_owned_order_identity');
  assert.equal(report.counts.cancelled, 0); assert.equal(await readFile(statePath, 'utf8'), before);
}));
