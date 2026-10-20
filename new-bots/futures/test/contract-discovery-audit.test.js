import test from 'node:test';
import assert from 'node:assert/strict';
import { auditFuturesContractDiscovery } from '../src/contractDiscoveryAudit.js';

const configured = (overrides = {}) => ({ contract: { symbol: 'ES', providerRawSymbol: 'ESZ6',
  expiry: '2026-12-18T14:30:00.000Z', tickSize: 0.25, tickValueUsd: 12.5, multiplier: 50, ...overrides } });
const definition = (overrides = {}) => ({ product: 'E-mini S&P 500', providerRawSymbol: 'ESZ6',
  providerInstrumentId: '12345', expiry: '2026-12-18T14:30:00.000Z', providerExchange: 'XCME',
  providerTickSize: 0.25, providerTickValue: 12.5, providerContractMultiplier: 50, tradeEligible: false, ...overrides });

test('full-directory audit does not confuse raw-symbol collisions across publishers', () => {
  const rows = [definition({ providerPublisherId: '1' }), definition({ providerPublisherId: '2', providerInstrumentId: 'other' })];
  const report = auditFuturesContractDiscovery([configured(), configured({ providerPublisherId: '2' }),
    configured({ providerPublisherId: '3' }), configured({ providerPublisherId: '2', providerInstrumentId: 'wrong' })], rows);
  assert.deepEqual(report.comparisons.map((r) => r.status), ['ambiguous_provider_identity', 'identity_and_price_specs_match',
    'provider_identity_mismatch', 'provider_identity_mismatch']);
  assert.equal(report.comparisons[1].providerInstrumentId, 'other');
  assert.equal(report.providerDefinitionCount, 2);
});

test('audits exact current contract identity and price-spec matches without granting eligibility', () => {
  const report = auditFuturesContractDiscovery([configured()], [definition()]);
  assert.equal(report.statusCounts.identity_and_price_specs_match, 1);
  assert.equal(report.comparisons[0].providerInstrumentId, '12345');
  assert.equal(report.comparisons[0].tradeEligible, false);
  assert.equal(report.providerDefinitions[0].tradeEligible, false);
  assert.match(report.note, /do not verify active status, margin, session/);
});

test('distinguishes missing definitions, expiry mismatch, and provider spec mismatch', () => {
  const report = auditFuturesContractDiscovery([
    configured(), configured({ providerRawSymbol: 'NQZ6' }), configured({ expiry: '2026-12-17T14:30:00.000Z' }),
  ], [definition(), definition({ providerRawSymbol: 'NQZ6', providerTickValue: 5 })]);
  assert.deepEqual(report.comparisons.map((row) => row.status), [
    'identity_and_price_specs_match', 'provider_spec_mismatch', 'expiry_mismatch',
  ]);
  assert.equal(report.statusCounts.provider_spec_mismatch, 1);
  assert.equal(report.statusCounts.expiry_mismatch, 1);
  assert.deepEqual(report.comparisons[1].reasons, ['tick_value_mismatch']);
});

test('keeps absent provider specification values unknown rather than treating them as matching', () => {
  const report = auditFuturesContractDiscovery([configured()], [definition({ providerTickValue: null })]);
  assert.equal(report.comparisons[0].status, 'partial_spec_comparison');
  assert.ok(report.comparisons[0].reasons.includes('tick_value_not_comparable'));
});

test('missing configured raw symbol is explicit and malformed inputs fail', () => {
  const report = auditFuturesContractDiscovery([{ contract: { symbol: 'ES' } }], [definition()]);
  assert.equal(report.comparisons[0].status, 'configured_raw_symbol_missing');
  assert.throws(() => auditFuturesContractDiscovery({}, []), /arrays/);
});
