import { coinbaseBookEvidence, krakenBookEvidence, cryptoRulesFixture } from '../fixtures/cryptoBookEvidence.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrimarySignalCandidate, reserveSharedPaperCandidate, markSharedPaperOrders } from '../primarySignal.js';
import { processPaperQuote, readPaperRiskLedger } from '../paperRisk.js';
import { cryptoExecutionIdentityKey, cryptoExposureKey, cryptoIdentityRejection } from '../cryptoExecutionIdentity.js';
import { buildCryptoPaperQuotes, resolveCryptoAsset } from '../../../crypto-bot/src/paperExecutionQuotes.js';
import { canonicalExposureKey } from '../exposureAliases.js';
import { runForwardShadowPaper } from '../forwardShadowPaper.js';

const now = Date.parse('2026-10-02T15:00:00Z');
const identity = { version: 1, namespace: 'coingecko', assetId: 'bitcoin', provider: 'Coinbase',
  pair: 'BTC-USD', base: 'BTC', quoteCurrency: 'USD', verificationSource: 'coingecko_tickers_complete',
  verifiedAt: new Date(now - 1000).toISOString() };
const input = { owner: 'crypto', assetClass: 'crypto', symbol: 'BTC', strategyId: 'identity-test', signalId: 'one',
  sessionDate: '2026-10-02', now, quote: { bid: 100, ask: 100.01, time: new Date(now).toISOString(), quality: 'executable', cryptoIdentity: identity, cryptoInstrumentRules: cryptoRulesFixture({ ...identity, time: now }), cryptoQuoteEvidence: coinbaseBookEvidence({ bid: 100, ask: 100.01, time: now }) },
  sessionOpen: true, stopPct: 1, targetPct: 2, forceExitAt: new Date(now + 3600000).toISOString(),
  roundTripFeesPerUnit: 0.02, slippageReservePerUnit: 0.01 };
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-crypto-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'risk.json');
  const config = { sharedPaperAccountEquity: 10000, sharedPaperStatePath: statePath, sharedPaperEmergencyStop: false };
  return { statePath, config };
}

test('ticker-only crypto prices cannot form a shared paper candidate', () => {
  const { cryptoIdentity: _identity, ...quote } = input.quote;
  const result = buildPrimarySignalCandidate({ ...input, quote });
  assert.equal(result.status, 'rejected');
  assert.ok(result.reasons.includes('crypto_execution_identity_required'));
});

test('paper reservation preserves the exact crypto asset, venue and pair', async t => {
  const { config } = await setup(t);
  const candidate = buildPrimarySignalCandidate(input);
  assert.equal(candidate.status, 'candidate');
  const result = await reserveSharedPaperCandidate(candidate.candidate, config, now);
  assert.equal(result.status, 'reserved');
  assert.deepEqual(result.order.cryptoIdentity, identity);
});

test('another venue or asset cannot fill or close a pinned crypto paper order', async t => {
  const { config, statePath } = await setup(t);
  const candidate = buildPrimarySignalCandidate(input).candidate;
  const reserved = await reserveSharedPaperCandidate(candidate, config, now);
  // Persist the identity explicitly so the baseline regression tests the quote
  // guard independently of the old reservation writer dropping this field.
  const ledger = await readPaperRiskLedger({ statePath }); ledger.orders[0].cryptoIdentity = identity;
  await writeFile(statePath, JSON.stringify(ledger));
  const before = await readFile(statePath, 'utf8');
  for (const changed of [{ provider: 'Kraken', pair: 'XBTUSD' }, { assetId: 'another-bitcoin' }, { pair: 'BTC-USDT', quoteCurrency: 'USDT' }]) {
    const result = await processPaperQuote(reserved.order.orderId, { ...input.quote, time: new Date(now + 1000).toISOString(),
      cryptoIdentity: { ...identity, ...changed } }, { statePath, now: now + 1000, emergencyStop: false });
    assert.equal(result.status, 'blocked');
    assert.equal(await readFile(statePath, 'utf8'), before);
  }
});

test('native USDT amounts are not silently recorded as USD paper profits', () => {
  const result = buildPrimarySignalCandidate({ ...input, quote: { ...input.quote,
    cryptoIdentity: { ...identity, provider: 'Binance', pair: 'BTCUSDT', quoteCurrency: 'USDT' } } });
  assert.equal(result.status, 'rejected');
  assert.ok(result.reasons.includes('crypto_quote_currency_conversion_required'));
});

const native = (id, stamp = now, bid = 100, ask = 100.01) => ({ provider: id.provider, pair: id.pair,
  base: id.base, target: id.quoteCurrency, observedAt: new Date(stamp).toISOString(), timestampBasis: id.provider === 'Coinbase' ? 'provider_order_book' : 'provider_event', bid, ask, cryptoIdentity: id, cryptoInstrumentRules: cryptoRulesFixture({ ...id, time: stamp }),
  cryptoQuoteEvidence: id.provider === 'Coinbase' ? coinbaseBookEvidence({ pair: id.pair, bid, ask, time: stamp })
    : krakenBookEvidence({ symbol: `${id.base}/${id.quoteCurrency}`, bid, ask, time: stamp }) });
const asset = (id, quotes) => ({ id, symbol: 'BTC', marketData: { quotes } });

test('colliding symbols remain separate across assets; conflicting claims for one native pair are quarantined', () => {
  const other = { ...identity, assetId: 'other-asset', provider: 'Kraken', pair: 'XBTUSD' };
  const rows = [asset('bitcoin', [native(identity)]), asset('other-asset', [native(other)])];
  const result = buildCryptoPaperQuotes(rows, { now });
  assert.equal(result.quotesByKey.size, 2);
  assert.equal(result.entryByAssetId.get('bitcoin').cryptoIdentity.assetId, 'bitcoin');
  assert.equal(result.entryByAssetId.get('other-asset').cryptoIdentity.assetId, 'other-asset');
  assert.equal(cryptoExposureKey(identity), 'BTC');
  for (const [assetId, root] of [['bitcoin', 'BTC'], ['ethereum', 'ETH'], ['solana', 'SOL'], ['ripple', 'XRP']]) {
    const crypto = { ...identity, assetId, base: root, pair: `${root}-USD` };
    assert.equal(cryptoExposureKey(crypto), canonicalExposureKey({ assetClass: 'future', future: { providerRawSymbol: `${root}Z6` } }),
      `${assetId} must retain its existing futures overlap`);
  }
  assert.equal(canonicalExposureKey({ assetClass: 'crypto', instrumentKey: 'BTC', cryptoIdentity: other }), 'CRYPTO:COINGECKO:OTHER-ASSET');
  assert.equal(resolveCryptoAsset({ symbol: 'BTC' }, new Map(rows.map(row => [row.id, row]))), null);
  const conflict = buildCryptoPaperQuotes([rows[0], asset('other-asset', [native({ ...identity, assetId: 'other-asset' })])], { now });
  assert.equal(conflict.quotesByKey.size, 0);
  assert.equal(conflict.diagnostics.rejectionCounts.conflicting_asset_ids_for_native_pair, 2);
});

test('quote identity, freshness, native units and duplicate rows produce explicit rejection counts', () => {
  for (const maxQuoteAgeMs of [0, NaN, Infinity, -1, '15000']) assert.throws(() => buildCryptoPaperQuotes([], { now, maxQuoteAgeMs }), TypeError);
  for (const [quote, reason] of [
    [{ ...native(identity), bid: true }, 'crypto_quote_not_current_and_executable'],
    [{ ...native(identity), timestampBasis: 'response_received' }, 'crypto_quote_not_current_and_executable'],
    [native(identity, now - 20000), 'crypto_quote_not_current_and_executable'],
    [{ ...native(identity), pair: 'FAKE-USD' }, 'crypto_quote_identity_mismatch'],
    [native({ ...identity, assetId: 'different' }), 'crypto_quote_identity_mismatch'],
    [native({ ...identity, verifiedAt: new Date(now - 70 * 60000).toISOString() }), 'crypto_identity_evidence_stale_or_future'],
    [native({ ...identity, pair: 'BTC-USDT', quoteCurrency: 'USDT' }), 'crypto_quote_currency_conversion_required'],
  ]) {
    const result = buildCryptoPaperQuotes([asset('bitcoin', [quote])], { now });
    assert.equal(result.quotesByKey.size, 0, reason);
    assert.equal(result.diagnostics.rejectionCounts[reason], 1, reason);
  }
  const duplicate = buildCryptoPaperQuotes([asset('bitcoin', [native(identity), native(identity)])], { now });
  assert.equal(duplicate.quotesByKey.size, 0);
  assert.equal(duplicate.entryByAssetId.size, 0);
  assert.equal(cryptoIdentityRejection({ ...identity, verifiedAt: new Date(now + 10000).toISOString() }, now), 'crypto_identity_evidence_stale_or_future');
});

test('later exact-venue observations fill and close; a fresher alternate venue cannot replace the stored source', async t => {
  const { config, statePath } = await setup(t);
  const initial = buildCryptoPaperQuotes([asset('bitcoin', [native(identity)])], { now });
  const built = buildPrimarySignalCandidate({ ...input, quote: initial.entryByAssetId.get('bitcoin'), signal: { assetId: 'bitcoin' } });
  const reserved = await reserveSharedPaperCandidate(built.candidate, config, now);
  assert.equal(reserved.status, 'reserved');
  const alternate = { ...identity, provider: 'Kraken', pair: 'XBTUSD' };
  const missingPinned = buildCryptoPaperQuotes([asset('bitcoin', [native(alternate, now + 1000)])], { now: now + 1000 });
  await markSharedPaperOrders({ owner: 'crypto', config, now: now + 1000, quotesBySymbol: missingPinned.quotesByKey });
  assert.equal((await readPaperRiskLedger({ statePath })).orders[0].status, 'reserved');
  const both = buildCryptoPaperQuotes([asset('bitcoin', [native(identity, now + 2000), native(alternate, now + 3000, 109, 109.01)])], { now: now + 3000 });
  assert.equal(both.entryByAssetId.get('bitcoin').cryptoIdentity.provider, 'Kraken', 'new entry selection can differ');
  await markSharedPaperOrders({ owner: 'crypto', config, now: now + 3000, quotesBySymbol: both.quotesByKey });
  assert.equal((await readPaperRiskLedger({ statePath })).orders[0].status, 'filled');
  assert.equal((await readPaperRiskLedger({ statePath })).orders[0].fillPrice, 100.01);
  const close = buildCryptoPaperQuotes([asset('bitcoin', [native(identity, now + 4000, 103, 103.01)])], { now: now + 4000 });
  await markSharedPaperOrders({ owner: 'crypto', config, now: now + 4000, quotesBySymbol: close.quotesByKey });
  const order = (await readPaperRiskLedger({ statePath })).orders[0];
  assert.equal(order.status, 'closed'); assert.equal(order.exitReason, 'target');
  assert.equal(order.cryptoIdentity.pair, 'BTC-USD');
  assert.ok(Number.isFinite(order.realizedPnlUsd));
});

test('legacy crypto reservations can cancel but identity-less positions never get an invented venue', async t => {
  const { config, statePath } = await setup(t);
  const reserved = await reserveSharedPaperCandidate(buildPrimarySignalCandidate(input).candidate, config, now);
  const ledger = await readPaperRiskLedger({ statePath }); delete ledger.orders[0].cryptoIdentity;
  await writeFile(statePath, JSON.stringify(ledger));
  const marks = new Map([['BTC', input.quote], [cryptoExecutionIdentityKey(identity), input.quote]]);
  const report = await markSharedPaperOrders({ owner: 'crypto', config, now, quotesBySymbol: marks });
  assert.equal(report.rejectionReasons.legacy_crypto_execution_identity_unavailable, 1);
  assert.equal((await readPaperRiskLedger({ statePath })).orders[0].status, 'reserved');
  const cancel = await processPaperQuote(reserved.order.orderId, null, { statePath, now, emergencyStop: true });
  assert.equal(cancel.status, 'cancelled');
});

test('forward shadow books retain exact source routing after the candidate leaves the shortlist', async t => {
  const { statePath } = await setup(t);
  const base = { owner: 'crypto', strategyVersion: 'crypto-identity-test-v1',
    profiles: [{ id: 'baseline', overrides: { targetScale: 1 }, hypothesis: 'Observe the original target.',
      changeMade: 'Keep the original target.', reason: 'Verify source-pinned forward outcomes.' }],
    allowlist: ['targetScale'], baseConfig: {}, stateDirectory: `${statePath}-shadow`, accountEquity: 10000,
    riskPolicy: { emergencyStop: false }, maxQuoteAgeMs: 15000, maxSpreadPct: 0.5, sessionOpen: true,
    sessionDate: input.sessionDate, evaluate: row => row.candidate ? { status: 'candidate', candidate: row.candidate } : { status: 'no-setup' } };
  await runForwardShadowPaper({ ...base, now, observations: [{}] });
  const entryQuote = { ...input.quote, time: new Date(now + 1000).toISOString(),
    cryptoQuoteEvidence: coinbaseBookEvidence({ bid: 100, ask: 100.01, time: now + 1000 }) };
  const candidate = buildPrimarySignalCandidate({ ...input, now: now + 1000, quote: entryQuote }).candidate;
  const created = (await runForwardShadowPaper({ ...base, now: now + 1000, observations: [{ candidate }] }))[0];
  assert.equal(created.counts.reservations, 1);
  const update = async (time, id, bid, ask) => runForwardShadowPaper({ ...base, now: time, observations: [],
    quotesByInstrument: buildCryptoPaperQuotes([asset('bitcoin', [native(id, time, bid, ask)])], { now: time }).quotesByKey });
  await update(now + 2000, { ...identity, provider: 'Kraken', pair: 'XBTUSD' }, 100, 100.01);
  assert.equal((await readPaperRiskLedger({ statePath: created.statePath })).orders[0].status, 'reserved');
  await update(now + 3000, identity, 100, 100.01);
  assert.equal((await readPaperRiskLedger({ statePath: created.statePath })).orders[0].status, 'filled');
  await update(now + 4000, identity, 103, 103.01);
  assert.equal((await readPaperRiskLedger({ statePath: created.statePath })).orders[0].status, 'closed');
});
