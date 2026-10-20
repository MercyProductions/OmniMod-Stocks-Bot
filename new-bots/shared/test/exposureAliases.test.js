import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalExposureKey, canonicalExposureKeys, effectiveExposureDirection } from '../exposureAliases.js';

test('inverse ETF/ETP trade sides normalize to the represented underlying direction', () => {
  assert.equal(effectiveExposureDirection({ assetClass: 'etf', direction: 'long', instrumentMetadata: { inverse: true } }), 'short');
  assert.equal(effectiveExposureDirection({ assetClass: 'etp', direction: 'short', instrumentMetadata: { productType: 'inverse_etf' } }), 'long');
  assert.equal(effectiveExposureDirection({ assetClass: 'etf', direction: 'long', inverse: true }), 'short');
  assert.equal(effectiveExposureDirection({ assetClass: 'etf', direction: 'long', instrumentMetadata: { inverse: false } }), 'long');
  assert.equal(effectiveExposureDirection({ assetClass: 'stock', direction: 'long', instrumentMetadata: { inverse: true } }), 'long');
  assert.equal(effectiveExposureDirection({ assetClass: 'etf', direction: 'unknown', inverse: true }), null);
});

test('option positions use their underlying thesis direction for shared exposure checks', () => {
  assert.equal(effectiveExposureDirection({ assetClass: 'option', direction: 'long', underlyingDirection: 'short' }), 'short');
  assert.equal(effectiveExposureDirection({ assetClass: 'option', direction: 'long', researchSignal: { direction: 'short' } }), 'short');
  assert.equal(effectiveExposureDirection({ assetClass: 'option', direction: 'long', underlyingDirection: 'long' }), 'long');
});

test('known Futures roots share underlying exposure with their stock, ETF, and Forex counterparts', () => {
  assert.equal(canonicalExposureKey({ assetClass: 'future', instrumentKey: 'CME_ESZ6', exposureKey: 'MISCONFIGURED', future: { providerRawSymbol: 'ESZ6' } }), 'SPY');
  assert.equal(canonicalExposureKey({ assetClass: 'future', instrumentKey: 'CME_MNQZ6', exposureKey: 'MISCONFIGURED', future: { providerRawSymbol: 'MNQZ6' } }), 'QQQ');
  assert.equal(canonicalExposureKey({ assetClass: 'future', instrumentKey: 'CME:GC:202612', exposureKey: 'MISCONFIGURED' }), 'GLD');
  assert.equal(canonicalExposureKey({ assetClass: 'future', instrumentKey: 'CME_CLZ6', exposureKey: 'MISCONFIGURED', future: { providerRawSymbol: 'CLZ6' } }), 'OIL');
  assert.equal(canonicalExposureKey({ assetClass: 'future', instrumentKey: 'CME:6E:202612', exposureKey: 'MISCONFIGURED' }), 'EUR_USD');
  assert.equal(canonicalExposureKey({ assetClass: 'future', instrumentKey: 'CME:6J:202612', exposureKey: 'MISCONFIGURED' }), 'JPY_USD');
  assert.equal(canonicalExposureKey({ assetClass: 'future', instrumentKey: 'CME:6C:202612', exposureKey: 'MISCONFIGURED' }), 'CAD_USD');
  assert.equal(canonicalExposureKey({ assetClass: 'future', instrumentKey: 'CME:6S:202612', exposureKey: 'MISCONFIGURED' }), 'CHF_USD');
  for (const [symbol, expected] of [['M6EZ6', 'EUR_USD'], ['E7Z6', 'EUR_USD'], ['M6BZ6', 'GBP_USD'], ['M6AZ6', 'AUD_USD'],
    ['MJYZ6', 'JPY_USD'], ['MCDZ6', 'CAD_USD'], ['MSFZ6', 'CHF_USD'],
    ['M6JZ6', 'USD_JPY'], ['M6CZ6', 'USD_CAD'], ['M6SZ6', 'USD_CHF'],
    ['6MZ6', 'MXN_USD'], ['BRZ6', 'BRL_USD'], ['6ZZ6', 'ZAR_USD'], ['6RZ6', 'RUB_USD'],
    ['SIRZ6', 'INR_USD'], ['CKOU6', 'CZK_USD'], ['6HZ6', 'CNH_USD'], ['UNZ6', 'NOK_USD'], ['SEZ6', 'SEK_USD']]) {
    assert.equal(canonicalExposureKey({ assetClass: 'future', instrumentKey: `CME_${symbol}`, future: { providerRawSymbol: symbol } }), expected, symbol);
  }
});

test('unknown futures preserve their explicit exposure key and non-futures ignore futures metadata', () => {
  assert.equal(canonicalExposureKey({ assetClass: 'future', instrumentKey: 'CME:XYZ:202612', exposureKey: 'CUSTOM_RISK' }), 'CUSTOM_RISK');
  assert.equal(canonicalExposureKey({ assetClass: 'stock', instrumentKey: 'XYZ', exposureKey: 'CUSTOM_RISK', future: { providerRawSymbol: 'ESZ6' } }), 'CUSTOM_RISK');
});

test('CME single-asset cryptocurrency futures map to the corresponding primary Crypto exposure', () => {
  const mappings = [
    ['BTC', 'BTC'], ['MBT', 'BTC'], ['BTE', 'BTC'], ['EBM', 'BTC'], ['BFF', 'BTC'], ['QBTC', 'BTC'],
    ['ETH', 'ETH'], ['MET', 'ETH'], ['ETE', 'ETH'], ['EEM', 'ETH'], ['QETH', 'ETH'],
    ['SOL', 'SOL'], ['MSL', 'SOL'], ['QSOL', 'SOL'], ['XRP', 'XRP'], ['MXP', 'XRP'], ['QXRP', 'XRP'],
    ['ADA', 'ADA'], ['MCA', 'ADA'], ['AVA', 'AVAX'], ['MAV', 'AVAX'], ['LNK', 'LINK'], ['MLN', 'LINK'],
    ['XLM', 'XLM'], ['MXL', 'XLM'], ['SUI', 'SUI'], ['MSU', 'SUI'],
  ];
  for (const [root, expected] of mappings) {
    const raw = `${root}Z6`;
    assert.equal(canonicalExposureKey({ assetClass: 'future', instrumentKey: `CME_${raw}`, exposureKey: 'UNTRUSTED',
      future: { providerRawSymbol: raw } }), expected, root);
  }
  assert.equal(canonicalExposureKey({ assetClass: 'future', instrumentKey: 'CME:QBTC:202612', exposureKey: 'UNTRUSTED' }), 'BTC');
  assert.equal(canonicalExposureKey({ assetClass: 'future', instrumentKey: 'CME:EBR:202612', exposureKey: 'UNTRUSTED' }), 'ETH_BTC_RATIO');
  assert.equal(canonicalExposureKey({ assetClass: 'future', instrumentKey: 'CME:BVI:202612', exposureKey: 'BTC_VOLATILITY' }), 'BTC_VOLATILITY');
});

test('exact S&P 500, Nasdaq-100, and Russell 2000 ETF wrappers share index exposure', () => {
  for (const ticker of ['SPY', 'VOO', 'IVV', 'SPYM', 'SPLG', 'UPRO', 'SPXU', 'SPXL', 'SPXS']) {
    assert.equal(canonicalExposureKey({ assetClass: 'etf', instrumentKey: ticker }), 'SPY', `${ticker} should map to S&P 500`);
  }
  for (const ticker of ['QQQ', 'QQQM', 'TQQQ', 'SQQQ', 'QLD', 'QID', 'PSQ']) {
    assert.equal(canonicalExposureKey({ assetClass: 'etf', instrumentKey: ticker }), 'QQQ', `${ticker} should map to Nasdaq-100`);
  }
  for (const ticker of ['IWM', 'VTWO', 'TNA', 'TZA']) {
    assert.equal(canonicalExposureKey({ assetClass: 'etf', instrumentKey: ticker }), 'IWM', `${ticker} should map to Russell 2000`);
  }
});

test('Treasury ETFs and listed Treasury futures share a conservative cross-market exposure bucket', () => {
  for (const ticker of ['TLT', 'TMF', 'TMV', 'IEF', 'SHY']) {
    assert.equal(canonicalExposureKey({ assetClass: 'etf', instrumentKey: ticker }), 'UST_RATES');
  }
  for (const symbol of ['ZTZ6', 'ZFN6', 'ZNZ6', 'TNZ6', 'ZBZ6', 'UBZ6', 'TWEZ6', 'ULZ6']) {
    assert.equal(canonicalExposureKey({ assetClass: 'future', instrumentKey: `CME_${symbol}`, exposureKey: 'WRONG', future: { providerRawSymbol: symbol } }), 'UST_RATES');
  }
  // Inflation-linked Treasuries remain separately keyed; no equivalence is asserted.
  assert.equal(canonicalExposureKey({ assetClass: 'etf', instrumentKey: 'TIP' }), 'TIP');
});

test('options on mapped ETFs and ETPs inherit their underlying cross-market exposure bucket', () => {
  assert.equal(canonicalExposureKey({ assetClass: 'option', instrumentKey: 'TQQQ261002C00050000+TQQQ261002C00055000', exposureKey: 'TQQQ' }), 'QQQ');
  assert.equal(canonicalExposureKey({ assetClass: 'option', instrumentKey: 'IBIT261002C00050000+IBIT261002C00055000', exposureKey: 'IBIT' }), 'BTC');
  assert.equal(canonicalExposureKey({ assetClass: 'option', instrumentKey: 'GLD261002C00200000+GLD261002C00210000', exposureKey: 'GLD' }), 'GLD');
});

test('broad commodity basket ETN keeps its primary key and reports mapped overlapping sleeves', () => {
  assert.deepEqual(canonicalExposureKeys({ assetClass: 'etp', instrumentKey: 'DJP', exposureKey: 'COMMODITY_BASKET' }),
    ['COMMODITY_BASKET', 'GLD', 'SLV', 'OIL', 'NATGAS', 'AGRICULTURE', 'CORN', 'SOYBEAN', 'WHEAT', 'KANSAS_WHEAT', 'SOYBEAN_OIL', 'SOYBEAN_MEAL', 'LIVE_CATTLE', 'FEEDER_CATTLE', 'LEAN_HOGS']);
  assert.deepEqual(canonicalExposureKeys({ assetClass: 'etf', instrumentKey: 'GLD' }), ['GLD']);
  assert.equal(canonicalExposureKey({ assetClass: 'etp', instrumentKey: 'DJP', exposureKey: 'COMMODITY_BASKET' }), 'COMMODITY_BASKET');
});

test('broad commodity and agriculture funds coordinate with mapped CME futures roots', () => {
  for (const root of ['ZC', 'MZC', 'XC', 'ZS', 'MZS', 'XK', 'ZW', 'MZW', 'XW', 'KE', 'MKC', 'ZL', 'MZL', 'ZM', 'MZM', 'LE', 'GF', 'HE']) {
    const raw = `${root}Z6`;
    const exposure = canonicalExposureKey({ assetClass: 'future', instrumentKey: `CME_${raw}`, exposureKey: 'UNTRUSTED', future: { providerRawSymbol: raw } });
    for (const ticker of ['DJP', 'DBC', 'PDBC']) {
      assert.ok(canonicalExposureKeys({ assetClass: 'etp', instrumentKey: ticker }).includes(exposure), `${root} must overlap ${ticker}`);
    }
  }
  assert.equal(canonicalExposureKey({ assetClass: 'future', instrumentKey: 'CME_MZCZ6', future: { providerRawSymbol: 'MZCZ6' } }), 'CORN');
  assert.equal(canonicalExposureKey({ assetClass: 'etf', instrumentKey: 'DBA' }), 'AGRICULTURE');
  assert.deepEqual(canonicalExposureKeys({ assetClass: 'etf', instrumentKey: 'DBA' }),
    ['AGRICULTURE', 'CORN', 'SOYBEAN', 'WHEAT', 'KANSAS_WHEAT', 'SOYBEAN_OIL', 'SOYBEAN_MEAL', 'LIVE_CATTLE', 'FEEDER_CATTLE', 'LEAN_HOGS']);
  for (const root of ['RB', 'HG']) {
    const raw = `${root}Z6`;
    const exposure = canonicalExposureKey({ assetClass: 'future', instrumentKey: `CME_${raw}`, future: { providerRawSymbol: raw } });
    const ticker = root === 'RB' ? 'UGA' : 'CPER';
    assert.equal(canonicalExposureKey({ assetClass: 'etp', instrumentKey: ticker }), exposure);
    assert.ok(canonicalExposureKeys({ assetClass: 'etp', instrumentKey: 'USCI' }).includes(exposure));
  }
  for (const ticker of ['DBA', 'PDBA']) {
    for (const root of ['ZC', 'ZS', 'ZW', 'KE', 'ZL', 'ZM', 'LE', 'GF', 'HE']) {
      const raw = `${root}Z6`;
      const exposure = canonicalExposureKey({ assetClass: 'future', instrumentKey: `CME_${raw}`, future: { providerRawSymbol: raw } });
      assert.ok(canonicalExposureKeys({ assetClass: 'etp', instrumentKey: ticker }).includes(exposure), `${root} must overlap ${ticker}`);
    }
  }
});
