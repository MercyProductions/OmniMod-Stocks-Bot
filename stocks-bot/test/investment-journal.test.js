import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stocks-investment-journal-'));
process.env.OMNIMOD_STOCKS_DATA_DIR = directory;
process.env.ALPACA_API_KEY_ID = 'unit-test-key';
process.env.ALPACA_API_SECRET_KEY = 'unit-test-secret';
const { collectInvestmentResearch, resolveWithExchangeCalendar, normalizeJournalBars, forwardJournalSummary } = await import('../src/investmentJournalStore.js');
const { createForwardObservation } = await import('../src/forwardInvestmentJournal.js');
const { readSecFundamentalEvidence } = await import('../src/secEvidenceJournal.js');
const { marketSession } = await import('../src/time.js');
after(async () => {
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});

function bars() {
  return ['2026-09-18', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'].map((date, i) => ({
    date, timestamp: Date.parse(`${date}T13:30:00Z`) / 1000, open: 100 + i, close: 100.5 + i
  }));
}
function longHistory(endingDate, count = 600, growth = 0.001) {
  const dates = [];
  const cursor = new Date(`${endingDate}T16:00:00Z`);
  while (dates.length < count) {
    const date = cursor.toISOString().slice(0, 10);
    if (marketSession(cursor).state === 'regular') dates.push(date);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  dates.reverse();
  return dates.map((date, index) => {
    const close = 100 * Math.exp(growth * index);
    return { date, timestamp: Date.parse(`${date}T13:30:00Z`) / 1000, open: close * 0.999,
      high: close * 1.01, low: close * 0.99, close, rawClose: close, dollarVolume: 100_000_000 };
  });
}
const clock = () => new Date('2026-09-18T22:00:00Z');
function fetcherFactory(onCall = () => {}) {
  return async (url) => {
    onCall();
    const rows = bars().slice(0, 1);
    return { ok: true, json: async () => ({ bars: { [new URL(url).pathname.split('/').at(-2)]: rows.map((b) => ({ t: new Date(b.timestamp * 1000).toISOString(), o: 100, h: 101, l: 99, c: 100.5, v: 1_000_000 })) } }) };
  };
}

test('forward daily resolution requires the independent exchange calendar, including jointly missing sessions', () => {
  const observation = createForwardObservation({ symbol: 'AAPL', benchmarkSymbol: 'SPY', horizonSessions: 5,
    asOf: '2026-09-18T20:00:00Z', observedAt: '2026-09-18T22:00:00Z', decision: 'WATCH_ONLY', score: null, marketRegime: 'mixed', volatilityRegime: 'extreme', modelVersion: 'stocks-daily-v1' });
  assert.equal(observation.marketRegime, 'mixed');
  assert.equal(observation.volatilityRegime, 'extreme');
  assert.throws(() => createForwardObservation({ symbol: 'AAPL', benchmarkSymbol: 'SPY', horizonSessions: 5,
    asOf: '2026-09-18T20:00:00Z', observedAt: '2026-09-18T22:00:00Z', decision: 'WATCH_ONLY', score: null, volatilityRegime: 'panic' }), /trend\/volatility regime/);
  const aligned = normalizeJournalBars(bars());
  const resolved = resolveWithExchangeCalendar(observation, aligned, aligned, new Date('2026-09-25T22:00:00Z'));
  assert.equal(resolved.resolution.entryAt, '2026-09-21T13:30:00.000Z');
  assert.equal(resolved.resolution.exitAt, '2026-09-25T20:00:00.000Z');
  const missing = [...aligned.filter((b) => b.date !== '2026-09-23'), ...normalizeJournalBars([{ date: '2026-09-28', timestamp: Date.parse('2026-09-28T13:30:00Z') / 1000, open: 110, close: 111 }])];
  assert.equal(resolveWithExchangeCalendar(observation, missing, missing, new Date('2026-09-28T22:00:00Z')).resolution, null);
  assert.equal(resolveWithExchangeCalendar(resolved, [], [], new Date('2026-09-28T22:00:00Z')), resolved);
});

test('forward research summary segments resolved non-overlapping evidence by trend and volatility regime', () => {
  const resolved = (symbol, regime, volatilityRegime, entry, exit, netReturn) => ({ symbol, marketRegime: regime, volatilityRegime, horizonSessions: 5,
    resolution: { status: 'resolved', entryAt: entry, exitAt: exit, netReturn, excessReturn: netReturn / 2 } });
  const summary = forwardJournalSummary([
    resolved('AAA', 'risk_on', 'extreme', '2026-09-01T00:00:00Z', '2026-09-05T00:00:00Z', .1),
    resolved('AAA', 'risk_on', 'extreme', '2026-09-03T00:00:00Z', '2026-09-10T00:00:00Z', -.1),
    resolved('BBB', 'risk_off', 'typical', '2026-09-01T00:00:00Z', '2026-09-05T00:00:00Z', -.02),
    resolved('CCC', 'mixed', undefined, '2026-09-01T00:00:00Z', '2026-09-05T00:00:00Z', .01)
  ]);
  assert.equal(summary.byRegime.risk_on[5].resolved, 2);
  assert.equal(summary.byRegime.risk_on[5].nonOverlappingWindows, 1);
  assert.equal(summary.byRegime.risk_on[5].meanNetReturnPct, 10);
  assert.equal(summary.byRegime.risk_off[5].meanNetReturnPct, -2);
  assert.equal(summary.byVolatilityRegime.extreme[5].resolved, 2);
  assert.equal(summary.byVolatilityRegime.extreme[5].nonOverlappingWindows, 1);
  assert.equal(summary.byVolatilityRegime.typical[5].meanExcessReturnPct, -1);
  assert.equal(summary.byVolatilityRegime.unknown[5].resolved, 1);
});

test('concurrent research requests serialize journal merges and preserve issuance timestamps', async () => {
  const options = { directory, clock, fetcher: fetcherFactory(), horizon: 20 };
  await Promise.all([collectInvestmentResearch('concurrent', ['AAA'], options), collectInvestmentResearch('concurrent', ['BBB'], options)]);
  let saved = JSON.parse(await fs.readFile(path.join(directory, 'investment-journal-concurrent.json'), 'utf8'));
  assert.equal(saved.observations.length, 2);
  assert.equal(saved.observations[0].marketRegime, 'insufficient_history');
  await collectInvestmentResearch('concurrent', ['AAA'], { ...options, clock: () => new Date('2026-09-18T23:00:00Z') });
  saved = JSON.parse(await fs.readFile(path.join(directory, 'investment-journal-concurrent.json'), 'utf8'));
  assert.equal(saved.observations.length, 2);
  assert.equal(saved.observations.find((r) => r.symbol === 'AAA').observedAt, '2026-09-18T22:00:00.000Z');
});

test('manual investment capture archives successful SEC facts at the actual observation time', async () => {
  const filing = { form: '10-K', filedAt: '2026-02-15', periodEnd: '2025-12-31', accession: '000012345626000001',
    url: 'https://www.sec.gov/Archives/edgar/data/123456/000012345626000001/annual.htm' };
  const manualReport = { fetchedAt: '2026-09-18T22:00:00.000Z', requested: ['AAA'], rows: [{ symbol: 'AAA', asOf: '2026-09-18', rawClose: 101,
    annualFundamentals: { status: 'partial', cik: '123456', filing, metrics: { revenue: { value: 1000, unit: 'USD', tag: 'Revenues', periodEnd: '2025-12-31' } } },
    annualValuation: { status: 'estimated', marketCapEstimate: 10100, priceToSales: 10.1 } }],
    benchmark: { symbol: 'SPY', sessions: 1, asOf: '2026-09-18', marketRegime: { label: 'insufficient_history' } },
    errors: [], histories: { AAA: { bars: bars().slice(0, 1), events: [] }, SPY: { bars: bars().slice(0, 1), events: [] } } };
  const result = await collectInvestmentResearch('sec-capture', ['AAA'], { directory, clock,
    researchFetcher: async () => structuredClone(manualReport), includeFundamentals: true, persistFundamentalEvidence: true });
  assert.equal(result.secEvidence.added, 1);
  const journal = await readSecFundamentalEvidence({ directory });
  assert.equal(journal.captures.length, 1);
  assert.equal(journal.captures[0].observedAt, '2026-09-18T22:00:00.000Z');
  assert.equal(journal.captures[0].symbol, 'AAA');
  assert.equal(journal.captures[0].metrics.revenue.value, 1000);
});

test('automatic daily research records all horizons once without rerunning on every scheduler tick', async () => {
  let requests = 0;
  const options = { directory, clock, fetcher: fetcherFactory(() => requests++), automatic: true };
  const first = await collectInvestmentResearch('automatic', ['AAA'], options);
  assert.equal(first.forward.issued, 3);
  assert.deepEqual(Object.keys(first.forward.byHorizon), ['5', '20', '60']);
  const before = requests;
  const second = await collectInvestmentResearch('automatic', ['AAA'], options);
  assert.equal(second.skipped, true);
  assert.equal(requests, before);
});

test('long-window shadow freezes a 60-session screen monthly and reports separate 6/12/36-month paths', async () => {
  const file = path.join(directory, 'investment-journal-long-window.json');
  const clockFor = (date) => () => new Date(`${date}T22:00:00.000Z`);
  const researchFetcher = async (_symbols, options) => {
    const date = options.now.toISOString().slice(0, 10);
    const stock = longHistory(date), benchmark = longHistory(date, 600, 0.0004);
    return { rows: [], errors: [], benchmark: { symbol: 'SPY', sessions: benchmark.length, asOf: date },
      histories: { AAA: { bars: stock, events: [] }, SPY: { bars: benchmark, events: [] } } };
  };
  const first = await collectInvestmentResearch('long-window', ['AAA'], { directory, clock: clockFor('2026-09-18'), automatic: true,
    researchFetcher, file });
  assert.equal(first.forward.byHorizon['60'].issued, 1);
  assert.equal(first.forward.longWindowShadow['126'].issued, 1);
  assert.equal(first.forward.longWindowShadow['252'].issued, 1);
  assert.equal(first.forward.longWindowShadow['756'].issued, 1);
  assert.equal(first.forward.longWindowShadow['756'].pending, 1);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.longWindowCaptureBySymbol.AAA, '2026-09');
  const nextSession = await collectInvestmentResearch('long-window', ['AAA'], { directory, clock: clockFor('2026-09-21'), automatic: true,
    researchFetcher, file });
  assert.equal(nextSession.forward.longWindowShadow['126'].issued, 1, 'daily ticks in the same month do not add overlapping long-window signals');
  assert.equal(nextSession.forward.byHorizon['5'].issued, 2, 'the existing short-horizon daily journal continues normally');
});

test('provider failure retries are capped at three attempts per completed session', async () => {
  let requests = 0;
  for (let hour = 21; hour <= 24; hour += 1) {
    await collectInvestmentResearch('failed-provider', ['AAA'], { directory, automatic: true,
      clock: () => new Date(Date.UTC(2026, 8, 18, hour)), retrySleep: async () => {}, requestGate: null,
      fetcher: async () => { requests++; return { ok: false, status: 503, headers: new Headers() }; } });
  }
  assert.equal(requests, 18); // SPY and AAA each get three bounded HTTP attempts on each of three sessions; fourth scheduler visit does no I/O.
});
