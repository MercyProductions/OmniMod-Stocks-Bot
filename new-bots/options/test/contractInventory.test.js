import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExpirationInventory, parseContractInventory, selectResearchExpirations, tradierUnderlyingSymbol } from '../src/contractInventory.js';

const now = Date.parse('2026-10-02T15:00:00Z'), expiry = '2026-10-09';
const leg = (overrides = {}) => ({ symbol: 'AAA261009C00100000', underlying: 'AAA', root_symbol: 'AAA',
  expiration_date: expiry, option_type: 'call', strike: 100, contract_size: 100, expiration_type: 'weekly',
  bid: 2, ask: 2.1, bid_date: now, ask_date: now, volume: 30, open_interest: 300, ...overrides });
const parse = (rows, context = {}) => parseContractInventory({ options: { option: rows } }, { underlying: 'AAA', expiry, now, environment: 'production', ...context });

test('complete expiration inventory retains long dates, validates dates and detects unexpected pages', () => {
  assert.deepEqual(parseExpirationInventory({ expirations: { date: ['2028-01-21', '2026-10-09', '2026-10-09'] } }),
    { dates: ['2026-10-09', '2028-01-21'], duplicateDates: 1 });
  assert.deepEqual(parseExpirationInventory({ expirations: null }).dates, []);
  for (const bad of [{}, { expirations: { date: ['2027-02-29'] } }, { expirations: { date: ['2026-13-01'] } },
    { expirations: { date: '2026-10-09' }, next_page_token: 'more' }, { expirations: {} }]) assert.throws(() => parseExpirationInventory(bad));
});

test('chain selection retains full inventory, separates DTE exclusions and rotates later eligible expirations', () => {
  const dates = ['2026-10-01', '2026-10-02', '2026-10-09', '2026-10-16', '2026-10-23', '2028-01-21'];
  const first = selectResearchExpirations(dates, { sessionDate: '2026-10-02' });
  assert.deepEqual(first.selected, ['2026-10-09', '2026-10-16']);
  assert.deepEqual(first.deferred, [{ date: '2026-10-23', reason: 'expiration_chain_budget' }]);
  const next = selectResearchExpirations(dates, { sessionDate: '2026-10-02', cursor: first.nextCursor });
  assert.deepEqual(next.selected, ['2026-10-09', '2026-10-23']);
  assert.ok(first.excluded.some((row) => row.date === '2028-01-21' && row.reason === 'outside_research_dte_window'));
  assert.deepEqual(dates, ['2026-10-01', '2026-10-02', '2026-10-09', '2026-10-16', '2026-10-23', '2028-01-21']);
});

test('every returned strike and side survives inventory; no contract is marked paper eligible', () => {
  const rows = Array.from({ length: 1200 }, (_, index) => leg({
    symbol: `AAA261009${index % 2 ? 'P' : 'C'}${String((100 + Math.floor(index / 2)) * 1000).padStart(8, '0')}`,
    option_type: index % 2 ? 'put' : 'call', strike: 100 + Math.floor(index / 2),
  }));
  const result = parse(rows);
  assert.equal(result.counts.contractsReturned, 1200);
  assert.equal(result.counts.verifiedIdentities, 1200);
  assert.equal(result.counts.calls, 600); assert.equal(result.counts.puts, 600);
  assert.equal(result.counts.distinctStrikes, 600);
  assert.equal(result.contracts.at(-1).strike, 699);
  assert.ok(result.contracts.every((row) => row.eligibleForPaper === false));
  assert.equal(result.contracts[0].quote.status, 'fresh_research');
});

test('provider field mismatches and unknown deliverables cannot become verified contract identities', () => {
  for (const [overrides, reason] of [
    [{ underlying: 'WRONG' }, 'underlying_identity_mismatch'], [{ underlying: undefined }, 'underlying_identity_mismatch'],
    [{ expiration_date: '2026-10-16' }, 'expiration_identity_mismatch'], [{ strike: 101 }, 'strike_identity_mismatch'],
    [{ option_type: 'put' }, 'option_type_mismatch'], [{ symbol: 'garbage' }, 'invalid_occ_identity'],
    [{ type: 'stock' }, 'instrument_type_mismatch'],
    [{ symbol: 'AAA260230C00100000' }, 'invalid_occ_identity'], [{ contract_size: undefined }, 'contract_deliverable_unverified'],
    [{ contract_size: 10 }, 'contract_deliverable_unverified'], [{ root_symbol: 'BBB' }, 'root_identity_mismatch'],
    [{ symbol: 'AAA1261009C00100000', root_symbol: 'AAA1' }, 'adjusted_root_unverified'],
  ]) {
    const result = parse([leg(overrides)]);
    assert.equal(result.counts.verifiedIdentities, 0, reason);
    assert.ok(result.contracts[0].reasons.includes(reason), reason);
  }
});

test('duplicate identities fail closed, including OCC root padding aliases', () => {
  const result = parse([leg(), leg({ symbol: 'AAA   261009C00100000' })]);
  assert.equal(result.counts.verifiedIdentities, 0);
  assert.equal(result.rejectionReasons.duplicate_contract_identity, 2);
});

test('share-class underlying and OCC root use their documented distinct separators', () => {
  assert.equal(tradierUnderlyingSymbol('BRK.B'), 'BRK/B');
  const result = parse([leg({ underlying: 'BRK/B', root_symbol: 'BRK.B', symbol: 'BRK.B261009C00100000' })], { underlying: 'BRK.B' });
  assert.equal(result.counts.verifiedIdentities, 1);
});

test('sandbox stays delayed research even for recent quotes; stale data and side skew remain explicit', () => {
  for (const delta of [0, 15 * 60000]) {
    const result = parse([leg({ bid_date: now - delta, ask_date: now - delta })], { environment: 'sandbox' });
    assert.equal(result.counts.delayedResearchQuotes, 1);
    assert.equal(result.counts.freshResearchQuotes, 0);
  }
  for (const overrides of [{ bid_date: now - 16000, ask_date: now - 16000 }, { bid_date: now + 10000 },
    { ask_date: now - 5000 }, { bid: true }, { strike: false }, { bid_date: null }, { bid_date: 1e100 }, { bid: '', ask: '' }]) {
    const result = parse([leg(overrides)]);
    assert.equal(result.counts.freshResearchQuotes, 0);
    assert.equal(result.counts.paperEligible, 0);
  }
});

test('empty chains are measured zero; missing or paginated chains stay unknown by rejection', () => {
  assert.equal(parseContractInventory({ options: null }, { underlying: 'AAA', expiry, environment: 'sandbox', now }).counts.contractsReturned, 0);
  for (const payload of [{}, { options: {} }, { options: { option: leg(), next_page_token: 'more' } }])
    assert.throws(() => parseContractInventory(payload, { underlying: 'AAA', expiry, environment: 'production', now }), /chain/);
});
