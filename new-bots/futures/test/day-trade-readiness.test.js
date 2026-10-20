import test from 'node:test';
import assert from 'node:assert/strict';
import { splitFuturesDaySessionInputs, summarizeFuturesDayTradeReadiness } from '../src/dayTradeReadiness.js';

test('separates exact unreviewed worksheet markers without changing approved rows', () => {
  const approved = { contract: { contractId: 'verified' } };
  const draft = { preparationStatus: 'draft_requires_manual_review', contract: { contractId: null } };
  const split = splitFuturesDaySessionInputs([draft, approved]);
  assert.deepEqual(split.dayTrades, [approved]);
  assert.deepEqual(split.draftRows, [draft]);
  const draftOnly = summarizeFuturesDayTradeReadiness([], { status: 'disabled', contracts: [] }, [draft]);
  assert.equal(draftOnly.status, 'draft_contracts_only');
  assert.deepEqual(draftOnly.draftRejectionReasons, [{ reason: 'contract_review_required', count: 1 }]);
  const mixed = summarizeFuturesDayTradeReadiness([approved], {}, [draft]);
  assert.equal(mixed.draftsSkipped, 1);
  assert.deepEqual(mixed.draftRejectionReasons, [{ reason: 'contract_review_required', count: 1 }]);
});

test('only exact draft marker is excluded; malformed input shape is rejected', () => {
  assert.deepEqual(splitFuturesDaySessionInputs([{ preparationStatus: 'draft' }]).dayTrades.length, 1);
  assert.throws(() => splitFuturesDaySessionInputs(null), /array/);
});

test('distinguishes an empty day-input file from a completed strategy scan with no signal', () => {
  const result = summarizeFuturesDayTradeReadiness([], { status: 'disabled', contracts: [] });
  assert.equal(result.status, 'no_configured_day_contracts');
  assert.equal(result.evaluatedRows, 0);
  assert.match(result.note, /day strategy did not run/);
  assert.match(result.note, /not an active-contract scan/);
});

test('dated definitions without verified day inputs remain discovery-only', () => {
  const result = summarizeFuturesDayTradeReadiness([], { status: 'refreshed', contracts: [{ tradeEligible: false }] });
  assert.equal(result.status, 'no_configured_day_contracts');
  assert.equal(result.providerDefinitions, 1);
  assert.match(result.note, /research-only/);
  assert.match(result.note, /No verified active-contract/);
});

test('provider discovery failure is distinguished from an unrun day scan', () => {
  const result = summarizeFuturesDayTradeReadiness([], { status: 'provider_error', contracts: [] });
  assert.equal(result.status, 'blocked_contract_discovery');
  assert.match(result.note, /discovery is unavailable \(provider_error\)/);
});

test('unavailable full-directory attempts are not described as a zero-result successful scan', () => {
  for (const status of ['credentials_missing', 'cost_cap_required', 'cost_cap_exceeded', 'incomplete_stream', 'refresh_locked', 'refresh_backoff']) {
    const result = summarizeFuturesDayTradeReadiness([], { status, contracts: [] });
    assert.equal(result.status, 'blocked_contract_discovery');
    assert.ok(result.note.includes(status));
    assert.equal(result.evaluatedRows, 0);
  }
});

test('configured rows mean the strategy evaluated inputs, not that setups passed', () => {
  const result = summarizeFuturesDayTradeReadiness([{ contract: {} }, { contract: {} }], { status: 'disabled', contracts: [] });
  assert.equal(result.status, 'configured_inputs_present');
  assert.equal(result.evaluatedRows, 2);
  assert.match(result.note, /row-level data, catalyst, strategy, and risk gates/);
});

test('invalid input shape is rejected instead of reported as zero', () => {
  assert.throws(() => summarizeFuturesDayTradeReadiness(null), /array/);
});
