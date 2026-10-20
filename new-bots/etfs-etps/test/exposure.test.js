import test from 'node:test';
import assert from 'node:assert/strict';
import { knownEtfUnderlying, resolveEtfExposureKey } from '../src/exposure.js';

test('leveraged and inverse wrappers share their underlying exposure key', () => {
  for (const [ticker, key] of Object.entries({
    QQQ: 'QQQ', TQQQ: 'QQQ', SQQQ: 'QQQ', SPY: 'SPY', UPRO: 'SPY', SPXU: 'SPY',
    SOXL: 'SOXX', SOXS: 'SOXX', LABU: 'XBI', LABD: 'XBI', NVDL: 'NVDA', NVD: 'NVDA',
    TLT: 'UST_RATES', TMF: 'UST_RATES', TMV: 'UST_RATES', IEF: 'UST_RATES', SHY: 'UST_RATES',
    UVXY: 'VIX', SVIX: 'VIX',
  })) {
    assert.equal(resolveEtfExposureKey(ticker), key);
    assert.equal(knownEtfUnderlying(ticker), key);
  }
});

test('crypto-linked ETF/ETP wrappers use the primary Crypto bot asset exposure keys', () => {
  assert.equal(resolveEtfExposureKey('IBIT'), 'BTC');
  assert.equal(resolveEtfExposureKey('BITX'), 'BTC');
  assert.equal(resolveEtfExposureKey('ETHE'), 'ETH');
  assert.equal(resolveEtfExposureKey('ETHA'), 'ETH');
});

test('unknown eligible tickers preserve explicit cross-bot aliases or default to ticker identity', () => {
  assert.equal(resolveEtfExposureKey('XLF'), 'XLF');
  assert.equal(resolveEtfExposureKey('CUSTOM', 'BANKS'), 'BANKS');
  assert.throws(() => resolveEtfExposureKey('XLF', 'bad/key'), /Invalid configured exposure key/);
  assert.throws(() => resolveEtfExposureKey('../SPY'), /valid ticker/);
});
