import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrimarySignalCandidate, reserveSharedPaperCandidate } from '../primarySignal.js';
import { evaluatePaperCandidate, processPaperQuote, readPaperRiskLedger } from '../paperRisk.js';
import { coinbaseBookEvidence } from '../fixtures/cryptoBookEvidence.js';
import { floorRiskQuantity, isIncrementMultiple, roundPriceIncrement } from '../decimalQuantity.js';
const now = Date.parse('2026-10-03T13:00:00Z');
const identity = { version: 1, namespace: 'coingecko', assetId: 'bitcoin', provider: 'Coinbase', pair: 'BTC-USD',
  base: 'BTC', quoteCurrency: 'USD', verificationSource: 'coingecko_tickers_complete', verifiedAt: new Date(now).toISOString() };
const rules = { version: 1, provider: 'Coinbase', pair: 'BTC-USD', base: 'BTC', quoteCurrency: 'USD',
  quantityIncrement: '0.00000001', priceIncrement: '0.01', minQuantity: '0.00000001', minNotional: '1',
  tradingState: 'online', source: 'coinbase_product', observedAt: new Date(now).toISOString() };
const quote = (time = now, bid = 99999.99, ask = 100000) => ({ bid, ask, time: new Date(time).toISOString(), quality: 'executable',
  cryptoIdentity: identity, cryptoInstrumentRules: rules, cryptoQuoteEvidence: coinbaseBookEvidence({ bid, ask, time }) });
const input = { owner: 'crypto', assetClass: 'crypto', symbol: 'BTC', strategyId: 'fractional-test', signalId: 'one', sessionDate: '2026-10-03',
  quote: quote(), now, sessionOpen: true, stopPct: 1, targetPct: 3, forceExitAt: new Date(now + 3600000).toISOString(),
  roundTripFeesPerUnit: 20, slippageReservePerUnit: 10 };
const portfolio = { accountEquity: 10000, realizedPnlToday: 0, openPositions: [] };

test('regression: the primary Crypto candidate uses the verified venue quantity increment', () => {
  const out = buildPrimarySignalCandidate(input);
  assert.equal(out.status, 'candidate');
  assert.equal(out.candidate.lotSize, 0.00000001);
  assert.deepEqual(out.candidate.cryptoInstrumentRules, rules);
});

test('regression: a legitimate fractional BTC quantity fits the unchanged 25-dollar risk budget', () => {
  const candidate = { ...buildPrimarySignalCandidate(input).candidate, lotSize: 0.00000001, cryptoInstrumentRules: rules };
  const result = evaluatePaperCandidate(candidate, portfolio, { now, maxTradeRiskPct: 0.25 });
  assert.equal(result.status, 'paper-approved', JSON.stringify(result.reasons));
  assert.equal(result.sizing.units, 0.02427184);
  assert.ok(result.sizing.units * 1030 <= 25);
});

test('regression: current trading restrictions and minimum order value are real gates', () => {
  const base = buildPrimarySignalCandidate({ ...input, quote: quote(now, 99.99, 100), roundTripFeesPerUnit: 0.02, slippageReservePerUnit: 0.01 }).candidate;
  for (const changes of [{ tradingState: 'cancel_only' }, { minNotional: '100000' }, { observedAt: new Date(now - 120000).toISOString() }]) {
    const result = evaluatePaperCandidate({ ...base, lotSize: 0.00000001, cryptoInstrumentRules: { ...rules, ...changes } }, portfolio, { now });
    assert.equal(result.status, 'blocked', JSON.stringify(changes));
  }
});

test('regression: fractional reservations survive the shared later-quote lifecycle', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-crypto-fractional-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'risk.json');
  const config = { sharedPaperAccountEquity: 10000, sharedPaperStatePath: statePath, sharedPaperEmergencyStop: false };
  const out = await reserveSharedPaperCandidate(buildPrimarySignalCandidate(input).candidate, config, now);
  assert.equal(out.status, 'reserved', JSON.stringify(out.reasons));
  assert.equal(out.order.units, 0.02427184);
  assert.deepEqual(out.order.cryptoInstrumentRules, rules);
  assert.equal((await processPaperQuote(out.order.orderId, quote(now + 1000), { statePath, now: now + 1000, emergencyStop: false })).status, 'filled');
  const done = await processPaperQuote(out.order.orderId, quote(now + 2000, 103100, 103100.01), { statePath, now: now + 2000, emergencyStop: false });
  assert.equal(done.status, 'closed');
  assert.equal(done.order.exitPrice, 103000, 'existing conservative target-price execution is preserved');
  assert.equal(done.order.grossPnlUsd, 72.82);
  assert.equal(done.order.realizedPnlUsd, 72.09);
  assert.equal((await readPaperRiskLedger({ statePath })).orders[0].units, 0.02427184);
});

test('decimal sizing stays on non-power-of-ten grids without increasing any risk budget', () => {
  assert.equal(floorRiskQuantity(1, 3, '0.00000001'), 0.33333333);
  assert.equal(floorRiskQuantity(10, 0.1, '0.03'), 99.99);
  assert.equal(floorRiskQuantity(1, 1, '0.000000000000000001'), 1, 'the integer step count need not fit a Number when the final quantity does');
  assert.equal(roundPriceIncrement(99.0099, '0.01', 'down'), 99);
  assert.equal(roundPriceIncrement(102.0102, '0.01', 'up'), 102.02);
  let checked = 0;
  for (const budget of [0.01, 0.5, 25, 750]) for (const risk of [0.005, 0.1, 1.03, 1030, 40000])
    for (const increment of ['0.00000001', '0.0025', '0.03', '1', '10']) {
      const units = floorRiskQuantity(budget, risk, increment);
      assert.ok(units >= 0 && Number.isFinite(units));
      if (units) { assert.ok(isIncrementMultiple(units, increment)); assert.ok(units * risk <= budget); }
      checked++;
    }
  assert.equal(checked, 100);
  for (const invalid of [null, undefined, '', true, [], {}, NaN, Infinity, -1])
    assert.equal(floorRiskQuantity(25, 1030, invalid), 0);
});

test('native price increments round planned stop outward and target upward before risk sizing', () => {
  const out = buildPrimarySignalCandidate({ ...input, quote: quote(now, 100, 100.01), stopPct: 1, targetPct: 2,
    roundTripFeesPerUnit: 0.02, slippageReservePerUnit: 0.01 });
  assert.equal(out.candidate.stopPrice, 99);
  assert.equal(out.candidate.targetPrice, 102.02);
  const decision = evaluatePaperCandidate(out.candidate, portfolio, { now });
  assert.equal(decision.status, 'paper-approved');
  assert.ok(decision.sizing.units * (100.01 - 99 + 0.03) <= 25);
  for (const changes of [{ lotSize: 1 }, { multiplier: 2 }, { entryPrice: 100.001 }, { targetPrice: 102.001 }]) {
    assert.equal(evaluatePaperCandidate({ ...out.candidate, ...changes }, portfolio, { now }).status, 'blocked');
  }
});

test('changing venue rules block invalid fills/exits without mutating quantity or inventing outcomes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-crypto-rule-change-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'risk.json');
  const config = { sharedPaperAccountEquity: 10000, sharedPaperStatePath: statePath, sharedPaperEmergencyStop: false };
  const reserved = await reserveSharedPaperCandidate(buildPrimarySignalCandidate(input).candidate, config, now);
  const run = (q, at = now + 1000) => processPaperQuote(reserved.order.orderId, q, { statePath, now: at, emergencyStop: false });
  for (const update of [null, { ...rules, tradingState: 'cancel_only' }, { ...rules, observedAt: new Date(now - 120000).toISOString() },
    { ...rules, minNotional: '1000000' }, { ...rules, minQuantity: '1' }, { ...rules, pair: 'ETH-USD', base: 'ETH' },
    { ...rules, quantityIncrement: '0.01', minQuantity: '0.01' }]) {
    const before = await readFile(statePath, 'utf8');
    assert.equal((await run({ ...quote(now + 1000), cryptoInstrumentRules: update })).status, 'blocked');
    assert.equal(await readFile(statePath, 'utf8'), before);
  }
  assert.equal((await run(quote(now + 1000))).status, 'filled');
  const before = await readFile(statePath, 'utf8');
  assert.equal((await run({ ...quote(now + 2000, 98900, 98900.01), cryptoInstrumentRules: { ...rules, minNotional: '1000000' } }, now + 2000)).status, 'blocked');
  assert.equal(await readFile(statePath, 'utf8'), before);
  const stopped = await run(quote(now + 3000, 98900, 98900.01), now + 3000);
  assert.equal(stopped.status, 'closed'); assert.equal(stopped.order.exitReason, 'stop');
  assert.ok(stopped.order.realizedPnlUsd < 0);
});

test('fractional capability cannot weaken portfolio, stale-data, emergency-stop or non-Crypto quantity rules', async t => {
  const candidate = buildPrimarySignalCandidate(input).candidate;
  for (const policy of [{ emergencyStop: true }, { maxGrossExposurePct: 1 }, { maxTotalOpenRiskPct: 0.001 },
    { now: now + 120000 }, { liveTradingEnabled: true }])
    assert.equal(evaluatePaperCandidate(candidate, portfolio, { now, ...policy }).status, 'blocked');
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-fractional-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'risk.json');
  const config = { sharedPaperAccountEquity: 10000, sharedPaperStatePath: statePath, sharedPaperEmergencyStop: false };
  const reserved = await reserveSharedPaperCandidate(candidate, config, now);
  const ledger = await readPaperRiskLedger({ statePath });
  delete ledger.orders[0].cryptoInstrumentRules;
  await writeFile(statePath, JSON.stringify(ledger));
  const blocked = await processPaperQuote(reserved.order.orderId, quote(now + 1000), { statePath, now: now + 1000, emergencyStop: false });
  assert.equal(blocked.reason, 'active_order_execution_metadata_invalid', 'unproven legacy fractional units must not be guessed');
  const cancelled = await processPaperQuote(reserved.order.orderId, null, { statePath, now: now + 1000, emergencyStop: true });
  assert.equal(cancelled.status, 'cancelled');
  for (const assetClass of ['stock', 'future', 'forex', 'etf', 'option']) {
    const corrupt = structuredClone(ledger); corrupt.orders[0].assetClass = assetClass;
    await writeFile(statePath, JSON.stringify(corrupt));
    const result = await processPaperQuote(reserved.order.orderId, quote(now + 2000), { statePath, now: now + 2000, emergencyStop: false });
    assert.equal(result.reason, 'active_order_execution_metadata_invalid', assetClass);
  }
});
