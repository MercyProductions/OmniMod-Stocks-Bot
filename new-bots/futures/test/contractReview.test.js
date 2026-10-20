import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewFuturesContractDefinitions } from '../src/contractReview.js';

const now = Date.parse('2026-09-29T16:00:00.000Z');
const expiry = '2026-12-18T14:30:00.000Z';
const definition = (overrides = {}) => ({ providerRawSymbol: 'ESZ6', product: 'E-mini S&P 500', expiry,
  definitionTimestamp: new Date(now - 60_000).toISOString(), providerTickSize: 0.25, providerContractMultiplier: 50, ...overrides });
const trade = (contract = {}) => ({ contract: { providerRawSymbol: 'ESZ6', contractId: 'CME:ES:202612', activeContract: true,
  contractSpecVerified: true, specSource: 'https://www.cmegroup.com/markets/equities/sp/e-mini-sandp500.contractSpecs.html', specVerifiedAt: new Date(now - 60_000).toISOString(),
  expiry, tickSize: 0.25, multiplier: 50, tickValueUsd: 12.5, initialMarginUsd: 15_000, maintenanceMarginUsd: 13_500,
  settlementReview: { settlementType: 'cash_settled', source: 'https://www.cmegroup.com/market-regulation/rulebook.html', reviewedAt: new Date(now - 60_000).toISOString(),
    lastTradeAt: expiry }, ...contract } });

test('contract review reports matched verified specs as human-review-ready but never trade eligible', () => {
  const report = reviewFuturesContractDefinitions([definition()], [trade()], { now });
  assert.equal(report.matched, 1);
  assert.equal(report.humanReviewReady, 1);
  assert.equal(report.tradeEligible, 0);
  assert.equal(report.rows[0].status, 'human_review_ready');
  assert.equal(report.rows[0].liveQuoteVerification, 'required_at_candidate_scan');
  assert.deepEqual(report.rows[0].contractSpec, {
    source: 'https://www.cmegroup.com/markets/equities/sp/e-mini-sandp500.contractSpecs.html', verifiedAt: new Date(now - 60_000).toISOString(),
    providerTickSize: 0.25, configuredTickSize: 0.25, providerMultiplier: 50, configuredMultiplier: 50,
    tickValueUsd: 12.5, initialMarginUsd: 15_000, maintenanceMarginUsd: 13_500,
  });
});

test('contract review identifies provider/config expiry, tick, definition-age, and delivery-cutoff mismatches', () => {
  const report = reviewFuturesContractDefinitions([
    definition({ expiry: '2026-12-18T14:31:00.000Z', providerTickSize: 0.5,
      definitionTimestamp: new Date(now - 25 * 60 * 60_000).toISOString() }),
  ], [trade({ expiry: '2026-12-18T14:30:00.000Z', settlementReview: { settlementType: 'physical_delivery',
    source: 'https://www.cmegroup.com/market-regulation/rulebook.html', reviewedAt: new Date(now - 60_000).toISOString(), lastTradeAt: expiry } })], { now });
  assert.equal(report.rows[0].status, 'review_failed');
  assert.ok(report.rows[0].reasons.includes('provider_configured_expiry_mismatch'));
  assert.ok(report.rows[0].reasons.includes('provider_configured_tick_size_mismatch'));
  assert.ok(report.rows[0].reasons.includes('provider_definition_stale_or_future'));
  assert.ok(report.rows[0].reasons.includes('physical_delivery_first_notice_cutoff_missing_or_invalid'));
  assert.equal(report.tradeEligible, 0);
});

test('contract review reports configured contracts absent from provider discovery', () => {
  const report = reviewFuturesContractDefinitions([], [trade()], { now });
  assert.equal(report.failed, 1);
  assert.ok(report.rows[0].reasons.includes('configured_contract_missing_from_current_provider_definitions'));
  assert.equal(report.rows[0].tradeEligible, false);
});

test('local cache fetch time cannot impersonate a missing provider definition timestamp', () => {
  const report = reviewFuturesContractDefinitions([definition({ definitionTimestamp: null, discoveredAt: new Date(now).toISOString() })], [trade()], { now });
  assert.ok(report.rows[0].reasons.includes('provider_definition_timestamp_missing'));
  assert.equal(report.humanReviewReady, 0);
});

test('contract review refuses incomplete or stale configured terms and missing provider spec fields', () => {
  const cases = [
    { configured: { specVerifiedAt: undefined }, expected: 'configured_contract_spec_source_or_timestamp_missing_stale_or_future' },
    { configured: { specSource: 'CME contract specifications' }, expected: 'configured_contract_spec_source_or_timestamp_missing_stale_or_future' },
    { configured: { specSource: 'http://www.cmegroup.com/specs' }, expected: 'configured_contract_spec_source_or_timestamp_missing_stale_or_future' },
    { configured: { specVerifiedAt: new Date(now - 91 * 86_400_000).toISOString() }, expected: 'configured_contract_spec_source_or_timestamp_missing_stale_or_future' },
    { configured: { tickValueUsd: undefined }, expected: 'configured_tick_multiplier_or_margin_terms_invalid' },
    { configured: { maintenanceMarginUsd: 16_000 }, expected: 'configured_tick_multiplier_or_margin_terms_invalid' },
    { configured: { settlementReview: { settlementType: 'cash_settled', source: 'http://www.cmegroup.com/rulebook',
      reviewedAt: new Date(now - 60_000).toISOString(), lastTradeAt: expiry } }, expected: 'settlement_terms_review_missing_stale_or_invalid' },
    { provider: { providerTickSize: undefined }, expected: 'provider_tick_size_missing_or_invalid' },
    { provider: { providerContractMultiplier: undefined }, expected: 'provider_contract_multiplier_missing_or_invalid' },
  ];
  for (const entry of cases) {
    const report = reviewFuturesContractDefinitions([definition(entry.provider)], [trade(entry.configured)], { now });
    assert.ok(report.rows[0].reasons.includes(entry.expected), entry.expected);
    assert.notEqual(report.rows[0].status, 'human_review_ready');
    assert.equal(report.tradeEligible, 0);
  }
});

test('contract review CLI reads local discovery and session JSON without provider access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-futures-contract-review-'));
  const discoveryPath = join(directory, 'discovery.json'), sessionPath = join(directory, 'session.json');
  try {
    const cliNow = Date.now();
    const verifiedAt = new Date(cliNow - 60_000).toISOString();
    const currentDefinition = definition({ definitionTimestamp: verifiedAt });
    const currentTrade = trade({ specVerifiedAt: verifiedAt, settlementReview: {
      settlementType: 'cash_settled', source: 'https://www.cmegroup.com/market-regulation/rulebook.html', reviewedAt: verifiedAt,
      lastTradeAt: expiry,
    } });
    await writeFile(discoveryPath, JSON.stringify({ fetchedAt: new Date(cliNow).toISOString(), contracts: [currentDefinition] }));
    await writeFile(sessionPath, JSON.stringify({ dayTrades: [currentTrade] }));
    const script = fileURLToPath(new URL('../scripts/reviewContracts.js', import.meta.url));
    const result = spawnSync(process.execPath, [script, discoveryPath, sessionPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.humanReviewReady, 1);
    assert.equal(report.tradeEligible, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
