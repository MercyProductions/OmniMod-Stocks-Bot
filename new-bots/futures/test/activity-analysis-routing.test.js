import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFuturesActivityReviews, routeFuturesActivityForAnalysis } from '../src/activityAnalysisRouting.js';
import { now } from './fixtures/activity.mjs';
import { fixture, iso } from './fixtures/activityRouting.mjs';

test('discovery selects an unconfigured root for bounded deep analysis, never approval or inherited prices', () => {
  const input = fixture(), row = input.reviews.dayTrades[0];
  row.quote = { bid: 1, ask: 1 }; row.bars = ['fabricated']; row.trendBars = ['fabricated']; row.liveDataStatus = 'complete';
  row.config.minRelativeVolume = .01; row.config.deliveryEntryBufferHours = 0;
  const out = routeFuturesActivityForAnalysis(input);
  assert.equal(out.diagnostics.selected, 1, JSON.stringify(out));
  assert.equal(out.diagnostics.strategyApprovalInferred, false);
  const selected = out.additions[0];
  assert.equal(selected.discoveryContext.cohort, 'broad_activity_reviewed');
  assert.equal(selected.discoveryContext.root, 'NEW0');
  assert.equal(selected.contract.providerInstrumentId, '1');
  assert.equal(selected.quote, null); assert.deepEqual(selected.bars, []); assert.deepEqual(selected.trendBars, []);
  assert.equal(selected.liveDataStatus, undefined);
  assert.deepEqual(selected.config, { roundTripFeesPerContract: 5, slippageReservePerContract: 2 });
  assert.equal(selected.discoveryContext.metadataSha256.length, 64);
  assert.equal(row.quote.bid, 1, 'source review not mutated');
});

test('a reviewed pool is metadata, not a universe or static deep work list', () => {
  const input = fixture(4); input.activity.candidates = [input.activity.candidates[3]];
  const out = routeFuturesActivityForAnalysis(input);
  assert.equal(out.diagnostics.reviewedPool, 4); assert.equal(out.additions.length, 1);
  assert.equal(out.additions[0].contract.providerRawSymbol, input.activity.candidates[0].providerRawSymbol);
});

test('missing review is counted per candidate; disabled routing preserves every configured row', () => {
  const input = fixture(2); input.reviews.dayTrades = [];
  assert.equal(routeFuturesActivityForAnalysis(input).diagnostics.rejectionReasons.reviewed_contract_metadata_missing, 2);
  input.configuredRows = [{ arbitrary: 'original' }]; input.enabled = false;
  const out = routeFuturesActivityForAnalysis(input);
  assert.equal(out.diagnostics.status, 'disabled'); assert.deepEqual(out.dayTrades, input.configuredRows);
});

test('routing requires current complete source evidence and both provider adapters', () => {
  for (const mutate of [
    x => { x.dayDataSource = 'manual'; }, x => { x.trendDataSource = 'manual'; },
    x => { x.activity.status = 'activity_scan_incomplete'; },
    x => { x.directory.diagnostics.observedFrom = '2026-10-01T00:00:00Z'; },
    x => { x.activity.diagnostics.directoryFingerprint = 'wrong'; },
    x => { x.maxAdditional = 0; }, x => { x.maxAdditional = NaN; },
    x => { x.reviews.status = 'review_file_unavailable_or_invalid'; },
  ]) {
    const input = fixture(); mutate(input); const out = routeFuturesActivityForAnalysis(input);
    assert.equal(out.diagnostics.status, 'blocked'); assert.equal(out.additions.length, 0);
    assert.ok(out.diagnostics.blockingReasons.length);
  }
});

test('stale bars and candidate identity substitution cannot reach detailed analysis', () => {
  for (const mutate of [
    x => { x.activity.candidates[0].latestBarClosedAt = iso(now - 301000); },
    x => { x.activity.candidates[0].latestBarClosedAt = iso(now + 1); },
    x => { x.activity.candidates[0].providerRawSymbol = 'WRONG'; },
    x => { x.activity.candidates[0].providerPublisherId = '2'; },
    x => { x.activity.candidates[0].expiry = '2026-12-19'; },
    x => { x.activity.candidates.push(structuredClone(x.activity.candidates[0])); },
  ]) {
    const input = fixture(); mutate(input); const out = routeFuturesActivityForAnalysis(input);
    assert.equal(out.additions.length, 0, JSON.stringify(out)); assert.ok(out.diagnostics.rejected > 0);
  }
});

test('review identity, terms, costs, session and catalyst guards all remain required', () => {
  const cases = [
    ['operator_review_required', r => { r.preparationStatus = 'draft_requires_manual_review'; }],
    ['review_definition_identity_mismatch', r => { r.contract.providerRoot = 'WRONG'; }],
    ['review_definition_identity_mismatch', r => { r.contract.expiry = '2026-12-19'; }],
    ['providerTickSize_review_mismatch', r => { r.contract.tickSize = .5; r.contract.tickValueUsd = 25; }],
    ['providerContractMultiplier_review_mismatch', r => { r.contract.multiplier = 100; r.contract.tickValueUsd = 25; }],
    ['contract_initial_margin_invalid', r => { r.contract.initialMarginUsd = null; }],
    ['contract_spec_stale', r => { r.contract.specVerifiedAt = iso(now - 100 * 86400000); }],
    ['settlement_entry_cutoff_buffer_active', r => { r.contract.settlementReview.lastTradeAt = iso(now + 3600000); }],
    ['physical_delivery_first_notice_cutoff_missing_or_invalid', r => { r.contract.settlementReview.settlementType = 'physical_delivery'; }],
    ['session_source_or_freshness_invalid', r => { r.session.reviewedAt = iso(now - 86400001); }],
    ['outside_strategy_entry_session', r => { r.session.closeTime = iso(now + 1000); }],
    ['fresh_clear_catalyst_review_required', r => { r.catalystReview.status = 'blocked'; }],
    ['explicit_contract_cost_reserves_required', r => { r.config.slippageReservePerContract = null; }],
  ];
  for (const [reason, mutate] of cases) {
    const input = fixture(); mutate(input.reviews.dayTrades[0]); const out = routeFuturesActivityForAnalysis(input);
    assert.equal(out.additions.length, 0, reason); assert.ok(out.decisions[0].reasons.includes(reason), JSON.stringify(out));
  }
});

test('conflicting reviewed identities reject all affected rows, not last-record-wins', () => {
  const input = fixture(); input.reviews.dayTrades.push(structuredClone(input.reviews.dayTrades[0]));
  const out = routeFuturesActivityForAnalysis(input);
  assert.equal(out.additions.length, 0); assert.ok(out.decisions[0].reasons.includes('ambiguous_review_identity'));
});

test('unverified currency/definition terms stay research-only; Finnhub review refresh remains downstream', () => {
  const input = fixture(); input.directory.contracts[0].providerCurrency = 'EUR';
  const out = routeFuturesActivityForAnalysis(input);
  assert.equal(out.additions.length, 0); assert.ok(out.decisions[0].reasons.includes('usd_contract_accounting_not_verified'));
  input.directory.contracts[0].providerCurrency = 'USD'; input.catalystSource = 'finnhub'; input.reviews.dayTrades[0].catalystReview = null;
  assert.equal(routeFuturesActivityForAnalysis(input).additions.length, 1);
  input.directory.contracts[0].providerContractMultiplier = null;
  assert.equal(routeFuturesActivityForAnalysis(input).additions.length, 0);
});

test('existing rows have priority and bounded excess is recorded without truncating discovery', () => {
  const input = fixture(4); input.configuredRows = [input.reviews.dayTrades[0]]; input.maxAdditional = 1;
  const out = routeFuturesActivityForAnalysis(input);
  assert.equal(out.dayTrades[0], input.configuredRows[0]); assert.equal(out.diagnostics.selected, 1);
  assert.equal(out.diagnostics.activityCandidates, 4); assert.equal(out.diagnostics.alreadyConfigured, 1);
  assert.equal(out.diagnostics.deferred, 2); assert.equal(out.diagnostics.rejected, 0);
  input.configuredRows = Array.from({ length: 100 }, (_, i) => ({ contract: { providerRawSymbol: `OLD${i}` } }));
  assert.equal(routeFuturesActivityForAnalysis(input).diagnostics.deferred, 4);
});

test('review files are bounded, schema-checked and fingerprinted; errors contain no input text', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omni-routing-reviews-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'review.json'); const input = fixture();
  await writeFile(path, JSON.stringify({ schemaVersion: 1, sessionDate: '2026-10-02', dayTrades: input.reviews.dayTrades }));
  const loaded = await loadFuturesActivityReviews(path); assert.equal(loaded.status, 'loaded'); assert.equal(loaded.sha256.length, 64);
  input.reviews = loaded; assert.equal(routeFuturesActivityForAnalysis(input).additions.length, 1);
  await writeFile(path, 'secret-invalid-json'); const invalid = await loadFuturesActivityReviews(path);
  assert.equal(invalid.status, 'review_file_unavailable_or_invalid'); assert.doesNotMatch(JSON.stringify(invalid), /secret/);
  await writeFile(path, '{}'); assert.equal((await loadFuturesActivityReviews(path)).status, 'review_file_schema_invalid');
  await writeFile(path, Buffer.alloc(8 * 1024 * 1024 + 1)); assert.equal((await loadFuturesActivityReviews(path)).status, 'review_file_limit_exceeded');
  assert.equal((await loadFuturesActivityReviews('')).status, 'review_file_not_configured');
});
