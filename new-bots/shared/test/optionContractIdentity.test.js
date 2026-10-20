import test from 'node:test';
import assert from 'node:assert/strict';
import { optionIdentityOccurrences, parseOccSymbol, tradierContractIdentity, validateStandardOptionIdentity } from '../optionContractIdentity.js';

const context = { underlying: 'BRK.B', expiry: '2026-10-16' };
const row = { symbol: 'BRK.B261016C00450000', underlying: 'BRK/B', expiration_date: context.expiry,
  option_type: 'call', strike: 450, contract_size: 100, type: 'option', root_symbol: 'BRK.B' };

test('standard provider identity independently reconciles share class, OCC components and multiplier', () => {
  const identity = tradierContractIdentity(row, context);
  assert.equal(identity.valid, true);
  assert.equal(identity.underlying, 'BRK/B');
  assert.equal(identity.symbol, row.symbol);
  assert.equal(validateStandardOptionIdentity(identity, context).valid, true);
});

test('mismatched provider fields and unverified adjusted deliverables fail closed', () => {
  const cases = [
    [{ underlying: 'SPY' }, 'underlying_identity_mismatch'], [{ underlying: undefined }, 'underlying_identity_mismatch'],
    [{ expiration_date: '2026-10-23' }, 'expiration_identity_mismatch'], [{ strike: 449 }, 'strike_identity_mismatch'],
    [{ strike: true }, 'strike_identity_mismatch'], [{ option_type: 'put' }, 'option_type_mismatch'],
    [{ symbol: 'BRK.B261023C00450000' }, 'expiration_identity_mismatch'],
    [{ symbol: 'BRKB1261016C00450000', root_symbol: 'BRKB1' }, 'adjusted_root_unverified'],
    [{ contract_size: undefined }, 'contract_deliverable_unverified'], [{ contract_size: 10 }, 'contract_deliverable_unverified'],
    [{ contract_size: true }, 'contract_deliverable_unverified'], [{ type: 'stock' }, 'instrument_type_mismatch'],
    [{ root_symbol: 'BRK.A' }, 'root_identity_mismatch'],
  ];
  for (const [override, reason] of cases) {
    const result = tradierContractIdentity({ ...row, ...override }, context);
    assert.equal(result.valid, false, reason);
    assert.ok(result.reasons.includes(reason), JSON.stringify(result));
  }
});

test('duplicate canonical identities reject all occurrences, including padded aliases', () => {
  const rows = [row, { ...row, symbol: 'BRK.B 261016C00450000' }];
  const occurrences = optionIdentityOccurrences(rows);
  for (const value of rows) assert.ok(tradierContractIdentity(value, { ...context, occurrences }).reasons.includes('duplicate_contract_identity'));
});

test('impossible dates, zero strike, symbol placeholders and malformed values never parse', () => {
  for (const value of ['SPY260230C00100000', 'SPY261016C00000000', 'SPY-C100', null, true, {}, 'aapl261016C00100000'])
    assert.equal(parseOccSymbol(value), null);
  assert.deepEqual(parseOccSymbol('SPY   261016P00100000'), { canonical: 'SPY261016P00100000', root: 'SPY', expiry: '2026-10-16', type: 'put', strike: 100 });
});
