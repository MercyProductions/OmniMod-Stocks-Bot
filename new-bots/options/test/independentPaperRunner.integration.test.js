import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NOW } from './underlyingResearchFixtures.js';

test('actual Options runner freezes and reserves independent research without primary signals or approved Discord output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-option-paper-runner-'));
  try {
    const ledger = join(directory, 'production.json'), input = join(directory, 'input.json');
    const preload = join(directory, 'provider.mjs'), reviews = join(directory, 'reviews.json');
    const original = JSON.stringify({ schemaVersion: 1, orders: [], events: [] });
    await writeFile(ledger, original);
    await writeFile(input, JSON.stringify({ signals: [] }));
    await writeFile(reviews, JSON.stringify({ reviews: [{ symbol: 'FRESH', status: 'clear', source: 'manual-review',
      summary: 'Synthetic catalyst clearance.', reviewedAt: new Date(NOW).toISOString() }],
      assignmentReviews: [{ symbol: 'FRESH', status: 'clear', source: 'https://issuer.example/dividends',
        summary: 'Synthetic assignment clearance.', reviewedAt: new Date(NOW).toISOString(), reviewedThrough: '2026-10-09', nextExDividendDate: null }] }));
    await writeFile(preload, `
import { researchInput, NOW } from ${JSON.stringify(new URL('./underlyingResearchFixtures.js', import.meta.url).href)};
import { appendFile } from 'node:fs/promises';
const started = performance.now();
Date.now = () => NOW + Number(process.env.TEST_SCAN_OFFSET_MS || 0) + Math.floor(performance.now() - started);
const callsPath = ${JSON.stringify(join(directory, 'calls.jsonl'))};
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input), time = Date.now(), iso = new Date(time).toISOString();
  await appendFile(callsPath, JSON.stringify({ path: url.pathname, method: init.method || 'GET' }) + '\\n');
  if ((init.method || 'GET') !== 'GET' || url.hostname === 'discord.com') throw new Error('Unexpected external mutation');
  let payload;
  if (url.pathname === '/v2/assets') payload = [{ id: 'durable-test-id', symbol: 'FRESH', class: 'us_equity', status: 'active', exchange: 'NYSE', tradable: true, attributes: ['has_options'] }];
  else if (url.pathname === '/v2/clock') payload = { timestamp: iso, is_open: true, next_open: '2026-10-05T13:30:00Z', next_close: '2026-10-02T20:00:00Z' };
  else if (url.pathname === '/v2/calendar') payload = [{ date: '2026-10-02', open: '09:30', close: '16:00' }];
  else if (url.pathname === '/v2/stocks/snapshots') payload = { FRESH: { latestQuote: { bp: 102, ap: 102.02, t: iso }, dailyBar: { o: 100, c: 102, h: 103, l: 99, v: 100000, t: '2026-10-02T04:00:00Z' } } };
  else if (url.pathname === '/v2/stocks/bars') payload = { bars: { FRESH: researchInput().bars }, next_page_token: null };
  else if (url.pathname === '/v2/stocks/quotes/latest') payload = { quotes: { FRESH: { bp: 100.39, ap: 100.41, bs: 10, as: 10, t: iso } } };
  else if (url.pathname === '/v1/markets/clock') payload = { clock: { state: 'open', timestamp: iso, next_change: '2026-10-02T20:00:00Z' } };
  else if (url.pathname === '/v1/markets/quotes') payload = { quotes: { quote: { symbol: 'FRESH', bid: 100.39, ask: 100.41, bid_date: time, ask_date: time } } };
  else if (url.pathname === '/v1/markets/options/expirations') payload = { expirations: { date: ['2026-10-09'] } };
  else if (url.pathname === '/v1/markets/options/chains') payload = { options: { option: [
    { symbol: 'FRESH261009C00100000', strike: 100, bid: 1, ask: 1.02 },
    { symbol: 'FRESH261009C00101000', strike: 101, bid: 0.7, ask: 0.72 },
  ].map(row => ({ ...row, underlying: 'FRESH', root_symbol: 'FRESH', expiration_date: '2026-10-09', option_type: 'call',
    contract_size: 100, bid_date: time, ask_date: time, volume: 100, open_interest: 1000 })) } };
  else throw new Error('Unexpected fixture endpoint: ' + url.pathname);
  return { ok: true, status: 200, headers: new Headers({ 'X-Ratelimit-Available': '100' }), json: async () => payload };
};
`);
    const env = { ...process.env, OPTIONS_SOURCE: 'manual', OPTIONS_SIGNAL_SOURCE: 'manual', OPTIONS_SESSION_FILE: input,
      OPTIONS_CATALYST_SOURCE: 'manual', OPTIONS_ASSIGNMENT_DATA_SOURCE: 'manual', OPTIONS_CATALYST_REVIEW_FILE: reviews,
      OPTIONS_DISCOVERY_SOURCE: 'alpaca', OPTIONS_DISCOVERY_FEED: 'iex', OPTIONS_INTRADAY_RESEARCH_SOURCE: 'alpaca',
      ALPACA_API_KEY_ID: 'fixture-key', ALPACA_API_SECRET_KEY: 'fixture-secret',
      OPTIONS_CONTRACT_DISCOVERY_SOURCE: 'tradier', TRADIER_ENV: 'production', TRADIER_TOKEN: 'fixture-tradier',
      OPTIONS_INDEPENDENT_PAPER_SOURCE: 'tradier', OPTIONS_FEES_PER_CONTRACT_ROUND_TRIP: '0.65', OPTIONS_SLIPPAGE_RESERVE_PER_CONTRACT: '0.25',
      OPTIONS_EXPIRATION_CACHE_PATH: join(directory, 'expirations'), OPTIONS_CONTRACT_HISTORY_PATH: join(directory, 'contracts'),
      OPTIONS_DIRECTORY_CACHE_PATH: join(directory, 'directory.json'), OPTIONS_DISCOVERY_HISTORY_PATH: join(directory, 'history'),
      OPTIONS_INTRADAY_RESEARCH_HISTORY_PATH: join(directory, 'intraday'),
      TRADING_RISK_STATE_PATH: ledger, OMNIMOD_SIGNAL_RESEARCH_PATH: join(directory, 'signals.jsonl'),
      OMNIMOD_FORWARD_SHADOW_STATE_DIR: join(directory, 'shadow'), OMNIMOD_EMERGENCY_STOP: 'false', OMNIMOD_LIVE_TRADING_ENABLED: 'false',
      PAPER_ACCOUNT_EQUITY_USD: '50000', DISCORD_TOKEN: '', DISCORD_WEBHOOK_URL: '', DISCORD_DELIVERY_MODE: 'webhook' };
    const run = (offset) => {
      const child = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, fileURLToPath(new URL('../src/index.js', import.meta.url))],
        { cwd: directory, encoding: 'utf8', timeout: 20000, env: { ...env, TEST_SCAN_OFFSET_MS: String(offset) } });
      assert.equal(child.status, 0, child.stderr);
      return JSON.parse(child.stdout);
    };
    const frozen = run(0);
    assert.equal(frozen.independentIntradayResearch.diagnostics.technicalWatches, 1, JSON.stringify(frozen.independentIntradayResearch));
    assert.equal(frozen.independentOptionPaperResearch.diagnostics.strategyCandidates, 1, JSON.stringify(frozen.independentOptionPaperResearch));
    assert.equal(frozen.independentOptionPaperResearch.forward[0].manifest.status, 'frozen_new');
    // A second process must start after the previous scan, including paced API
    // work; restarting the fixture clock at NOW+1s would rewind durable state.
    const laterOffset = Date.parse(frozen.independentOptionPaperResearch.forward[0].manifest.frozenAt) - NOW + 1000;
    const later = run(laterOffset);
    assert.equal(later.independentOptionPaperResearch.diagnostics.shadowReservations, 1, JSON.stringify(later.independentOptionPaperResearch));
    assert.equal(later.scanDiagnostics.funnel.primarySignals, 0);
    assert.equal(later.scanDiagnostics.funnel.strategyCandidates, 0);
    assert.equal(later.scanDiagnostics.funnel.paperReservations, 0);
    assert.equal(later.discordDelivery.posted, false);
    assert.equal(await readFile(ledger, 'utf8'), original);
    const calls = (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.every(row => row.method === 'GET' && !row.path.includes('/orders')));
    assert.equal(later.paperJournal.rowsWritten, 0);
    const journal = JSON.parse((await readFile(join(directory, 'shadow/options-independent/observations-2026-10-02.jsonl'), 'utf8')).trim().split('\n').at(-1));
    assert.doesNotMatch(JSON.stringify(journal), /fixture-(key|secret|tradier)/);
    assert.equal(later.scanDiagnostics.universe.optionPaperResearch.forwardGates.manifests[0], 'active');
  } finally {
    const rel = relative(tmpdir(), directory); assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  }
});
