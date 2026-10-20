import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendDayMarketDataHistory, buildDayMarketDataHistoryRow } from '../src/dayMarketDataHistory.js';

const payload = (checkedAt) => ({
  checkedAt, status: 'PASS_PROVIDER_PLUMBING_ONLY',
  checks: { elapsedMs: 2100, requestedSymbols: 1, symbolsWithAtLeastTwoFreshExecutableExchangeQuotes: 1,
    symbolsWithQuoteDisagreement: [], historicalCandleSourceAvailable: true },
  report: [{ symbol: 'BTC', quoteProviders: [
    { provider: 'Binance', bid: 100, ask: 101 }, { provider: 'Coinbase', bid: 100, ask: 101 },
  ], conflicted: false, staleOrInvalidQuotes: 0, providerErrors: [], historicalCandles: { count: 299 } }],
  globalProviderErrors: [],
});

test('smoke-history row keeps coverage evidence without retaining prices or provider error text', () => {
  const input = payload('2026-09-30T09:00:00.000Z');
  input.report[0].providerErrors = ['credential=private-value'];
  input.report[0].quoteRejectionCounts = { future_observation_timestamp: 1, invalid_or_crossed_quote: 2 };
  const row = buildDayMarketDataHistoryRow(input);
  assert.deepEqual(row, {
    schemaVersion: 1, checkedAt: '2026-09-30T09:00:00.000Z', status: 'PASS_PROVIDER_PLUMBING_ONLY',
    elapsedMs: 2100, requestedSymbols: 1, symbolsWithTwoFreshQuotes: 1, symbolsWithQuoteDisagreement: 0,
    historicalCandleSourceAvailable: true, globalProviderErrorCount: 0,
    symbols: [{ symbol: 'BTC', providers: ['Binance', 'Coinbase'], quoteDisagreement: false,
      staleOrInvalidQuotes: 0, quoteRejectionCounts: { future_observation_timestamp: 1, invalid_or_crossed_quote: 2 },
      providerErrorCount: 1, candleCount: 299 }],
  });
  assert.equal(JSON.stringify(row).includes('private-value'), false);
  assert.equal(JSON.stringify(row).includes('"bid"'), false);
});

test('append-only smoke journal preserves observations across runs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-smoke-history-'));
  const path = join(directory, 'history.ndjson');
  try {
    await appendDayMarketDataHistory(buildDayMarketDataHistoryRow(payload('2026-09-30T09:00:00Z')), { path });
    await appendDayMarketDataHistory(buildDayMarketDataHistoryRow(payload('2026-09-30T09:05:00Z')), { path });
    const rows = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.checkedAt), ['2026-09-30T09:00:00.000Z', '2026-09-30T09:05:00.000Z']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('history builder rejects malformed observations and writer rejects unvalidated rows', async () => {
  assert.throws(() => buildDayMarketDataHistoryRow({ status: 'PASS_PROVIDER_PLUMBING_ONLY' }), /valid provider-smoke/);
  await assert.rejects(appendDayMarketDataHistory({ schemaVersion: 1 }, { path: join(tmpdir(), 'invalid-history.ndjson') }), /validated smoke row/);
});
