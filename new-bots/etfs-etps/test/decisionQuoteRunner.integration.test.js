import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { etfInput } from './quoteRefreshFixtures.js';

test('actual ETF runner refreshes after slow history and records real decision stages without external delivery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'etf-decision-runner-'));
  try {
    const preload = join(directory, 'provider.mjs'), reviews = join(directory, 'reviews.json'), ledger = join(directory, 'ledger.json');
    await writeFile(reviews, JSON.stringify({ SPY: etfInput().session.catalystReview }));
    await writeFile(preload, `
import { etfInput, rawQuote, NOW } from ${JSON.stringify(new URL('./quoteRefreshFixtures.js', import.meta.url).href)};
import { appendFile } from 'node:fs/promises';
const RealDate = Date, started = performance.now(); let offset = 0;
let snapshotParsed;
const snapshotReady = new Promise(done => { snapshotParsed = done; });
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [Date.now()])); }
  static now() { return NOW + offset + Math.floor(performance.now() - started); }
};
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input); await appendFile(${JSON.stringify(join(directory, 'calls.jsonl'))}, JSON.stringify({ path: url.pathname, method: options.method || 'GET' })+'\\n');
  let payload;
  if (url.pathname === '/v2/clock') payload = { timestamp: new Date().toISOString(), is_open: true };
  else if (url.pathname === '/v2/calendar') payload = [{ date: '2026-09-29', open: '09:30', close: '16:00' }];
  else if (url.pathname === '/v2/assets') payload = [{ symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', exchange: 'ARCA', status: 'active', tradable: true }];
  else if (url.pathname === '/v1beta1/news') payload = { news: [] };
  else if (url.pathname === '/v2/stocks/snapshots') payload = { SPY: { latestQuote: rawQuote(Date.now()) } };
  else if (url.pathname === '/v2/stocks/bars') {
    await snapshotReady;
    await new Promise(done => setImmediate(done)); offset += 20000;
    payload = { bars: { SPY: etfInput().bars.map(b => ({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume })) } };
  } else if (url.pathname === '/v2/stocks/quotes/latest') payload = { quotes: { SPY: rawQuote(Date.now()) } };
  else throw new Error('Unexpected endpoint '+url.pathname);
  return { ok: true, status: 200, headers: new Headers(), json: async () => {
    if (url.pathname === '/v2/stocks/snapshots') snapshotParsed();
    return payload;
  } };
};
`);
    const env = { ...process.env, ETF_SOURCE: 'alpaca', ETF_DISCOVERY_MODE: 'baseline', ETF_SYMBOLS: 'SPY', ETF_ALPACA_FEED: 'sip',
      ALPACA_API_KEY_ID: 'synthetic-runner', ALPACA_API_SECRET_KEY: 'synthetic', ETF_CATALYST_SOURCE: 'manual', ETF_CATALYST_REVIEW_FILE: reviews,
      ETF_UNIVERSE_CACHE_PATH: fileURLToPath(new URL('./fixtures/etf-universe-cache.json', import.meta.url)), ETF_TIME_OF_DAY_VOLUME_PROFILE_ENABLED: 'false',
      ETF_ROUND_TRIP_FEES_PER_UNIT: '0.01', ETF_SLIPPAGE_RESERVE_PER_UNIT: '0.01', PAPER_ACCOUNT_EQUITY_USD: '10000',
      TRADING_RISK_STATE_PATH: ledger, OMNIMOD_FORWARD_SHADOW_STATE_DIR: join(directory, 'shadow'), OMNIMOD_SIGNAL_RESEARCH_PATH: join(directory, 'signals.jsonl'),
      OMNIMOD_EMERGENCY_STOP: 'false', OMNIMOD_LIVE_TRADING_ENABLED: 'false', DISCORD_TOKEN: '', DISCORD_WEBHOOK_URL: '', DISCORD_DELIVERY_MODE: 'webhook' };
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, fileURLToPath(new URL('../src/index.js', import.meta.url))],
      { cwd: directory, env, encoding: 'utf8', timeout: 20000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.results[0].status, 'reserved', JSON.stringify(result.results));
    assert.equal(result.scanDiagnostics.decisionQuotes.qualification.refreshed, 1);
    assert.ok(result.scanDiagnostics.quoteCollectionAges.afterDetailedData[0].quoteAgeMs >= 20000);
    assert.ok(result.scanDiagnostics.decisionQuotes.decisions[0].quoteAgeMs < 15000);
    assert.equal(result.discordDelivery.posted, false);
    assert.ok(result.forwardShadow.every(row => row.strategyVersion === 'etp-opening-range-breakout-shadow-v4-decision-quotes'));
    const journal = JSON.parse((await readFile(join(directory, 'data/etfs-etps-scan-diagnostics.jsonl'), 'utf8')).trim());
    assert.equal(journal.diagnostics.decisionQuotes.qualification.refreshed, 1);
    const calls = (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(row => row.path.endsWith('/quotes/latest')).length, 1);
    assert.ok(calls.every(row => row.method === 'GET' && !row.path.includes('/orders')));
    assert.equal(JSON.parse(await readFile(ledger, 'utf8')).orders[0].status, 'reserved');
  } finally {
    const rel = relative(tmpdir(), directory); assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  }
});
