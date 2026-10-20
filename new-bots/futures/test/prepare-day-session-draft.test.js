import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareFuturesDaySessionDraft } from '../src/prepareDaySessionDraft.js';
import { buildFuturesDiscoveryReview } from '../src/futuresDiscoveryReview.js';
import { validateActiveFutureContract } from '../src/universe.js';

const now = Date.parse('2026-09-30T15:00:00.000Z');
const products = [{ symbol: 'E-mini S&P 500', providerSymbol: 'ES.v.0', assetClass: 'equity-index-future', underlying: 'S&P 500' }];
const definitions = [{ product: 'E-mini S&P 500', providerSymbol: 'ES.v.0', providerRawSymbol: 'ESZ6', providerInstrumentId: '12345',
  providerPublisherId: '1', providerExchange: 'XCME', expiry: '2026-12-18T14:30:00.000Z',
  providerTickSize: 0.25, providerTickValue: 12.5, providerContractMultiplier: 50, providerContractSize: 50,
  definitionTimestamp: '2026-09-30T14:00:00.000Z', definitionSource: 'Databento GLBX.MDP3 definition schema', tradeEligible: true }];

test('provider definitions produce a complete but explicitly unverified day-session draft', () => {
  const draft = prepareFuturesDaySessionDraft(definitions, products, { now });
  assert.equal(draft.draft, true);
  assert.equal(draft.sessionDate, null);
  assert.equal(draft.dayTrades.length, 1);
  const row = draft.dayTrades[0];
  assert.equal(row.preparationStatus, 'draft_requires_manual_review');
  assert.equal(row.contract.providerRawSymbol, 'ESZ6');
  assert.equal(row.contract.providerInstrumentId, '12345');
  assert.deepEqual(row.contract.providerReference, { source: 'Databento GLBX.MDP3 definition schema', tickSize: 0.25,
    tickValueUsd: 12.5, multiplier: 50, contractSize: 50, unitOfMeasure: null, currency: null });
  assert.equal(row.contract.contractId, null);
  assert.equal(row.contract.activeContract, false);
  assert.equal(row.contract.contractSpecVerified, false);
  assert.equal(row.contract.tickSize, null);
  assert.equal(row.contract.initialMarginUsd, null);
  assert.equal(row.session, null);
  assert.equal(row.catalystReview.status, 'blocked');
  assert.equal(row.bars.length, 0);
  assert.equal(row.quote, null);
  assert.equal(row.config.roundTripFeesPerContract, null);
  assert.match(draft.note, /not a trade universe/);
  assert.throws(() => validateActiveFutureContract(row.contract, { now }), /Invalid or stale active futures/);
});

test('combined discovery review command never promotes provider definitions into eligible day contracts', () => {
  const report = buildFuturesDiscoveryReview({ contracts: definitions, metrics: [
    { provider: 'Databento', operation: 'estimated-contract-discovery-cost', estimatedCostUsd: 0.12, configuredCapUsd: 0.25 }
  ] }, products, { now });
  assert.equal(report.status, 'review_required');
  assert.equal(report.definitionsReceived, 1);
  assert.equal(report.reviewRowsCreated, 1);
  assert.equal(report.providerEstimatedCostUsd, 0.12);
  assert.equal(report.tradeEligibleContracts, 0);
  assert.equal(report.configuredDaySessionChanged, false);
  assert.equal(report.reviewDraft.dayTrades[0].preparationStatus, 'draft_requires_manual_review');
  assert.equal(report.reviewDraft.dayTrades[0].contract.activeContract, false);
  assert.equal(report.reviewDraft.dayTrades[0].contract.contractSpecVerified, false);
  assert.equal(report.reviewDraft.dayTrades[0].quote, null);
});

test('combined review reports prior-session volume-ranked mappings but keeps candidates ineligible', () => {
  const report = buildFuturesDiscoveryReview({ contracts: definitions, mappingStatus: [
    { product: 'E-mini S&P 500', providerSymbol: 'ES.v.0', status: 'resolved' },
  ], metrics: [
    { provider: 'Databento', operation: 'estimated-active-contract-discovery-cost', estimatedCostUsd: 0.03, configuredCapUsd: 0.25 },
  ] }, products, { now });
  assert.equal(report.providerEstimatedCostUsd, 0.03);
  assert.equal(report.volumeRankMappings[0].status, 'resolved');
  assert.match(report.volumeRankSelection, /previous trading session volume rank/);
  assert.match(report.note, /not proof of current-session liquidity/);
  assert.equal(report.tradeEligibleContracts, 0);
  assert.equal(report.reviewDraft.dayTrades[0].preparationStatus, 'draft_requires_manual_review');
});

test('combined discovery review reports no rows without inferring an empty tradable universe is safe', () => {
  const report = buildFuturesDiscoveryReview({ contracts: [], metrics: [] }, products, { now });
  assert.equal(report.status, 'no_review_rows');
  assert.equal(report.tradeEligibleContracts, 0);
  assert.equal(report.configuredDaySessionChanged, false);
});

test('combined discovery review preserves partial-definition rejection status without approving valid siblings', () => {
  const report = buildFuturesDiscoveryReview({ contracts: [definitions[0], definitions[0]], metrics: [] }, products, { now });
  assert.equal(report.status, 'review_required');
  assert.equal(report.reviewDraft.partial, true);
  assert.equal(report.reviewDraft.draftedDefinitions, 1);
  assert.equal(report.reviewDraft.rejectedDefinitions[0].reasonCodes[0], 'duplicate_provider_raw_symbol');
  assert.equal(report.tradeEligibleContracts, 0);
});

test('mixed provider definitions keep valid review drafts and return structured per-row rejections', () => {
  const result = prepareFuturesDaySessionDraft([
    definitions[0],
    { ...definitions[0], providerRawSymbol: 'ESH7', providerInstrumentId: '12346', product: 'Unknown' },
    { ...definitions[0], providerRawSymbol: 'ESM6', providerInstrumentId: '12347', expiry: '2026-06-18T14:30:00.000Z' },
    definitions[0],
  ], products, { now });
  assert.equal(result.definitionsReceived, 4);
  assert.equal(result.draftedDefinitions, 1);
  assert.equal(result.dayTrades[0].contract.providerRawSymbol, 'ESZ6');
  assert.equal(result.partial, true);
  assert.deepEqual(result.rejectedDefinitions, [
    { definitionIndex: 2, providerRawSymbol: 'ESH7', providerInstrumentId: '12346', reasonCodes: ['product_not_in_reviewed_registry'] },
    { definitionIndex: 3, providerRawSymbol: 'ESM6', providerInstrumentId: '12347', reasonCodes: ['provider_contract_expired'] },
    { definitionIndex: 4, providerRawSymbol: 'ESZ6', providerInstrumentId: '12345', reasonCodes: ['duplicate_provider_raw_symbol'] },
  ]);
});

test('malformed provider identity is a structured rejection while invalid top-level inputs still fail', () => {
  const result = prepareFuturesDaySessionDraft([{ ...definitions[0], providerRawSymbol: '', providerInstrumentId: '' }], products, { now });
  assert.equal(result.dayTrades.length, 0);
  assert.deepEqual(result.rejectedDefinitions[0].reasonCodes, ['provider_raw_symbol_missing', 'provider_instrument_id_missing']);
  assert.throws(() => prepareFuturesDaySessionDraft({}, products, { now }), /arrays/);
});

test('missing provider reference numbers stay unknown instead of becoming zero', () => {
  const row = prepareFuturesDaySessionDraft([{ ...definitions[0], providerTickSize: null, providerTickValue: '', providerContractMultiplier: false }], products, { now }).dayTrades[0];
  assert.equal(row.contract.providerReference.tickSize, null);
  assert.equal(row.contract.providerReference.tickValueUsd, null);
  assert.equal(row.contract.providerReference.multiplier, null);
});

test('stale, future, or missing provider definition timestamps cannot enter the review worksheet', () => {
  const result = prepareFuturesDaySessionDraft([
    { ...definitions[0], providerRawSymbol: 'ESZ6', definitionTimestamp: new Date(now - 24 * 60 * 60_000 - 1).toISOString() },
    { ...definitions[0], providerRawSymbol: 'ESH6', definitionTimestamp: new Date(now + 1).toISOString() },
    { ...definitions[0], providerRawSymbol: 'ESM6', definitionTimestamp: null },
    { ...definitions[0], providerRawSymbol: 'ESU6', definitionTimestamp: new Date(now - 24 * 60 * 60_000).toISOString() },
  ], products, { now });
  assert.deepEqual(result.dayTrades.map((row) => row.contract.providerRawSymbol), ['ESU6']);
  assert.deepEqual(result.rejectedDefinitions.map((row) => row.reasonCodes), [
    ['provider_definition_stale'],
    ['provider_definition_timestamp_in_future'],
    ['provider_definition_timestamp_missing_or_invalid'],
  ]);
});
