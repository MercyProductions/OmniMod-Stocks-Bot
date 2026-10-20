import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inspectActiveFutureContract, parseFuturesExpiry, validateActiveFutureContract, validateFuturesUniverse } from '../src/universe.js';

test('normalizes rows as continuous proxies and never treats them as verified contracts', () => {
  const rows = validateFuturesUniverse([{ symbol: 'Gold', providerSymbol: 'GC=F', assetClass: 'metal-future' }]);
  assert.equal(rows[0].contractMode, 'continuous-proxy');
  assert.equal(rows[0].contractSpecVerified, false);
  assert.equal(validateFuturesUniverse([{ symbol: 'E-mini S&P 500', providerSymbol: 'ES.v.0', assetClass: 'equity-index-future' }])[0].providerSymbol, 'ES.v.0');
});

test('active contracts require current verified expiry, tick-value consistency, and margin metadata', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const active = validateActiveFutureContract({
    symbol: 'ES', providerSymbol: 'ESZ26', providerRawSymbol: 'ESZ6', contractId: 'CME:ES:202612', assetClass: 'equity-index-future', exposureKey: 'SPY',
    activeContract: true, contractSpecVerified: true, expiry: '2026-12-18', multiplier: 50,
    tickSize: 0.25, tickValueUsd: 12.5, initialMarginUsd: 20_000, maintenanceMarginUsd: 18_000,
    specSource: 'https://example.test/exchange-specification', specVerifiedAt: '2026-09-29T10:00:00Z',
  }, { now });
  assert.equal(active.contractMode, 'active-contract');
  assert.equal(active.contractSpecVerified, true);
  assert.throws(() => validateActiveFutureContract({
    symbol: 'ES', providerSymbol: 'ESZ26', providerRawSymbol: 'ESZ6', contractId: 'CME:ES:202612', exposureKey: 'SPY', activeContract: true,
    contractSpecVerified: true, expiry: '2026-12-18', multiplier: 50, tickSize: 0.25,
    tickValueUsd: 10, initialMarginUsd: 20_000, maintenanceMarginUsd: 18_000,
    specSource: 'https://example.test/exchange-specification', specVerifiedAt: '2026-09-29T10:00:00Z',
  }, { now }), /Invalid or stale/);
});

test('verified contracts accept Databento ISO expiry timestamps and preserve exact expiry time', () => {
  const beforeExpiry = Date.parse('2026-12-18T14:29:59.000Z');
  const expiry = '2026-12-18T14:30:00.000Z';
  const row = { symbol: 'ES', providerSymbol: 'ESZ6', providerRawSymbol: 'ESZ6', contractId: 'CME:ES:202612', assetClass: 'equity-index-future', exposureKey: 'SPY',
    activeContract: true, contractSpecVerified: true, expiry, multiplier: 50, tickSize: 0.25, tickValueUsd: 12.5,
    initialMarginUsd: 20_000, maintenanceMarginUsd: 18_000, specSource: 'https://example.test/exchange-specification', specVerifiedAt: '2026-09-29T10:00:00Z' };
  const active = validateActiveFutureContract(row, { now: beforeExpiry });
  assert.equal(active.expiry, expiry);
  assert.equal(active.expiryAt, expiry);
  assert.throws(() => validateActiveFutureContract(row, { now: Date.parse(expiry) }), /Invalid or stale/);
  assert.equal(parseFuturesExpiry('2026-12-18'), Date.parse('2026-12-18T00:00:00.000Z'));
  assert.ok(Number.isNaN(parseFuturesExpiry('2026-02-30T14:30:00.000Z')));
  assert.ok(Number.isNaN(parseFuturesExpiry('2026-12-18T14:30:00')));
});

test('active contract preflight returns distinct actionable metadata rejection reasons', () => {
  const inspection = inspectActiveFutureContract({ symbol: 'ES', activeContract: true, contractSpecVerified: true }, { now: Date.parse('2026-09-29T12:00:00Z') });
  assert.equal(inspection.valid, false);
  for (const reason of ['provider_raw_symbol_missing_or_invalid', 'contract_spec_source_not_verified_https', 'contract_id_missing', 'contract_tick_or_multiplier_invalid']) {
    assert.ok(inspection.reasons.includes(reason), reason);
  }
});

test('rejects duplicate and malformed futures symbols', () => {
  assert.throws(() => validateFuturesUniverse([
    { symbol: 'Gold', providerSymbol: 'GC=F', assetClass: 'metal-future' },
    { symbol: 'gold', providerSymbol: 'GC=F', assetClass: 'metal-future' },
  ]), /Duplicate/);
  assert.throws(() => validateFuturesUniverse([{ symbol: 'Gold', providerSymbol: ' ', assetClass: 'metal-future' }]), /Invalid/);
});

test('configured research universe includes source-identified micro contracts while keeping them proxy-only', async () => {
  const path = fileURLToPath(new URL('../examples/futures.json', import.meta.url));
  const products = validateFuturesUniverse(JSON.parse(await readFile(path, 'utf8')));
  const roots = new Set(products.map((product) => product.providerSymbol));
  for (const root of ['MES.v.0', 'MNQ.v.0', 'M2K.v.0', 'MYM.v.0', 'MCL.v.0', 'MGC.v.0']) assert.ok(roots.has(root), root);
  // Keep the requested precious-metal, energy, and Treasury contracts in the
  // configured research universe. Continuous symbols remain research proxies;
  // live entry still requires separately verified active contracts and specs.
  for (const root of ['GC.v.0', 'MGC.v.0', 'CL.v.0', 'MCL.v.0', 'ZN.v.0', 'ZB.v.0']) assert.ok(roots.has(root), root);
  const agriculturalRoots = ['ZC.v.0','MZC.v.0','XC.v.0','ZS.v.0','MZS.v.0','XK.v.0','ZW.v.0','MZW.v.0','XW.v.0','KE.v.0','MKC.v.0','ZL.v.0','MZL.v.0','ZM.v.0','MZM.v.0','LE.v.0','GF.v.0','HE.v.0'];
  for (const root of agriculturalRoots) assert.ok(roots.has(root), root);
  assert.ok(products.length >= 36);
  for (const root of ['MES.v.0', 'MNQ.v.0', 'M2K.v.0', 'MYM.v.0', 'MCL.v.0', 'MGC.v.0', ...agriculturalRoots]) {
    const row = products.find((product) => product.providerSymbol === root);
    assert.equal(row.contractMode, 'continuous-proxy');
    assert.equal(row.contractSpecVerified, false);
  }
});

test('Futures environment example scans the complete configured research universe and sets delivery buffer', async () => {
  const example = await readFile(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8');
  assert.match(example, /^MAX_FUTURES=36$/m);
  assert.match(example, /^FUTURES_DELIVERY_ENTRY_BUFFER_HOURS=24$/m);
});
