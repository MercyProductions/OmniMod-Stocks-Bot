import { cryptoExposureKey } from './cryptoExecutionIdentity.js';

const UNDERLYING_BY_TICKER = Object.freeze({
  // Exact benchmark wrappers share the benchmark exposure key. SPLG is kept
  // for historical ledger rows; its issuer changed the live ticker to SPYM.
  SPY: 'SPY', VOO: 'SPY', IVV: 'SPY', SPYM: 'SPY', SPLG: 'SPY', UPRO: 'SPY', SPXU: 'SPY', SPXL: 'SPY', SPXS: 'SPY',
  QQQ: 'QQQ', QQQM: 'QQQ', TQQQ: 'QQQ', SQQQ: 'QQQ', QLD: 'QQQ', QID: 'QQQ', PSQ: 'QQQ',
  IWM: 'IWM', VTWO: 'IWM', TNA: 'IWM', TZA: 'IWM',
  SOXX: 'SOXX', SMH: 'SOXX', SOXL: 'SOXX', SOXS: 'SOXX',
  XBI: 'XBI', LABU: 'XBI', LABD: 'XBI',
  NVDA: 'NVDA', NVDL: 'NVDA', NVD: 'NVDA',
  IBIT: 'BTC', FBTC: 'BTC', BITO: 'BTC', BITX: 'BTC',
  ETHE: 'ETH', ETHA: 'ETH',
  GLD: 'GLD', IAU: 'GLD', UGL: 'GLD', GLL: 'GLD',
  SLV: 'SLV', SIVR: 'SLV', AGQ: 'SLV', ZSL: 'SLV',
  DBA: 'AGRICULTURE', PDBA: 'AGRICULTURE',
  // Treasury duration products share a conservative rates-risk bucket across
  // tenors until a validated curve-spread/correlation model exists.
  TLT: 'UST_RATES', TMF: 'UST_RATES', TMV: 'UST_RATES',
  IEF: 'UST_RATES', SHY: 'UST_RATES',
  USO: 'OIL', USL: 'OIL', BNO: 'OIL', UCO: 'OIL', SCO: 'OIL', DBO: 'OIL',
  UNG: 'NATGAS', UNL: 'NATGAS', BOIL: 'NATGAS', KOLD: 'NATGAS',
  UGA: 'GASOLINE', CPER: 'COPPER', USCI: 'COMMODITY_BASKET',
  YINN: 'CHINA_LARGE_CAP', YANG: 'CHINA_LARGE_CAP',
  UVXY: 'VIX', SVIX: 'VIX',
});

// Known futures roots map to the same underlying risk key used by spot/ETF bots.
// Unknown contracts continue to use their operator-supplied exposureKey.
const FUTURE_ROOT_TO_EXPOSURE = Object.freeze({
  ES: 'SPY', MES: 'SPY', NQ: 'QQQ', MNQ: 'QQQ', RTY: 'IWM', M2K: 'IWM', YM: 'DIA', MYM: 'DIA',
  GC: 'GLD', MGC: 'GLD', SI: 'SLV', SIL: 'SLV', CL: 'OIL', MCL: 'OIL', NG: 'NATGAS', QG: 'NATGAS',
  RB: 'GASOLINE', HG: 'COPPER',
  // U.S. Treasury futures: 2Y, 5Y, 10Y, Ultra 10Y, classic/ultra 30Y, 20Y.
  ZT: 'UST_RATES', ZF: 'UST_RATES', ZN: 'UST_RATES', TN: 'UST_RATES',
  ZB: 'UST_RATES', UB: 'UST_RATES', TWE: 'UST_RATES', UL: 'UST_RATES',
  // CME standard G10 FX futures are quoted USD per unit of foreign currency.
  // Therefore 6J/6C/6S use reciprocal OTC spot keys. Current CME micros use
  // M6E/M6B/M6A/E7 and MJY/MCD/MSF; legacy M6J/M6C/M6S were quoted in OTC
  // convention, so retain their inverse mappings for persisted positions.
  // CME FX Product Guide: https://www.cmegroup.com/markets/fx/fx-product-guide
  '6E': 'EUR_USD', E7: 'EUR_USD', M6E: 'EUR_USD',
  '6J': 'JPY_USD', MJY: 'JPY_USD', M6J: 'USD_JPY',
  '6B': 'GBP_USD', M6B: 'GBP_USD',
  '6A': 'AUD_USD', M6A: 'AUD_USD',
  '6C': 'CAD_USD', MCD: 'CAD_USD', M6C: 'USD_CAD',
  '6S': 'CHF_USD', MSF: 'CHF_USD', M6S: 'USD_CHF',
  '6N': 'NZD_USD',
  // CME's listed LATAM/emerging-market currency futures also quote USD per
  // foreign-currency unit; normalize them directionally for Forex overlap.
  '6M': 'MXN_USD', BR: 'BRL_USD', '6Z': 'ZAR_USD', '6R': 'RUB_USD',
  SIR: 'INR_USD', CKO: 'CZK_USD', '6H': 'CNH_USD', UN: 'NOK_USD', SE: 'SEK_USD',
  // CME-listed single-asset crypto futures and spot-quoted products share
  // their underlying coin's cross-bot exposure key. Product codes are taken
  // from CME's current Cryptocurrency Futures FAQ/product tables.
  BTC: 'BTC', MBT: 'BTC', BTE: 'BTC', EBM: 'BTC', BFF: 'BTC', QBTC: 'BTC',
  ETH: 'ETH', MET: 'ETH', ETE: 'ETH', EEM: 'ETH', QETH: 'ETH',
  SOL: 'SOL', MSL: 'SOL', QSOL: 'SOL', XRP: 'XRP', MXP: 'XRP', QXRP: 'XRP',
  ADA: 'ADA', MCA: 'ADA', AVA: 'AVAX', MAV: 'AVAX', LNK: 'LINK', MLN: 'LINK',
  XLM: 'XLM', MXL: 'XLM', SUI: 'SUI', MSU: 'SUI',
  EBR: 'ETH_BTC_RATIO',
  // CME grains, oilseeds, and livestock. Micro/mini roots map to the same
  // product sleeve; distinct commodities remain separately identifiable.
  ZC: 'CORN', MZC: 'CORN', XC: 'CORN',
  ZS: 'SOYBEAN', MZS: 'SOYBEAN', XK: 'SOYBEAN',
  ZW: 'WHEAT', MZW: 'WHEAT', XW: 'WHEAT',
  KE: 'KANSAS_WHEAT', MKC: 'KANSAS_WHEAT',
  ZL: 'SOYBEAN_OIL', MZL: 'SOYBEAN_OIL',
  ZM: 'SOYBEAN_MEAL', MZM: 'SOYBEAN_MEAL',
  LE: 'LIVE_CATTLE', GF: 'FEEDER_CATTLE', HE: 'LEAN_HOGS',
});

// DJP tracks a diversified commodity-futures index. It is not equivalent to
// any single leg, but it overlaps the commodity risk sleeves currently mapped
// in this project. Keep the basket identity and each mapped sleeve so the
// portfolio gate can detect cross-bot overlap without collapsing all
// commodities into one bucket.
const SECONDARY_EXPOSURES_BY_TICKER = Object.freeze({
  // The broad baskets overlap the listed commodity sleeves. These mappings
  // intentionally model identities, not changing weights or correlations.
  DJP: Object.freeze(['GLD', 'SLV', 'OIL', 'NATGAS', 'AGRICULTURE', 'CORN', 'SOYBEAN', 'WHEAT', 'KANSAS_WHEAT', 'SOYBEAN_OIL', 'SOYBEAN_MEAL', 'LIVE_CATTLE', 'FEEDER_CATTLE', 'LEAN_HOGS']),
  USCI: Object.freeze(['GLD', 'SLV', 'OIL', 'GASOLINE', 'NATGAS', 'COPPER', 'AGRICULTURE', 'CORN', 'SOYBEAN', 'WHEAT', 'KANSAS_WHEAT', 'SOYBEAN_OIL', 'SOYBEAN_MEAL', 'LIVE_CATTLE', 'FEEDER_CATTLE', 'LEAN_HOGS']),
  DBC: Object.freeze(['GLD', 'SLV', 'OIL', 'NATGAS', 'AGRICULTURE', 'CORN', 'SOYBEAN', 'WHEAT', 'KANSAS_WHEAT', 'SOYBEAN_OIL', 'SOYBEAN_MEAL', 'LIVE_CATTLE', 'FEEDER_CATTLE', 'LEAN_HOGS']),
  PDBC: Object.freeze(['GLD', 'SLV', 'OIL', 'NATGAS', 'AGRICULTURE', 'CORN', 'SOYBEAN', 'WHEAT', 'KANSAS_WHEAT', 'SOYBEAN_OIL', 'SOYBEAN_MEAL', 'LIVE_CATTLE', 'FEEDER_CATTLE', 'LEAN_HOGS']),
  DBA: Object.freeze(['AGRICULTURE', 'CORN', 'SOYBEAN', 'WHEAT', 'KANSAS_WHEAT', 'SOYBEAN_OIL', 'SOYBEAN_MEAL', 'LIVE_CATTLE', 'FEEDER_CATTLE', 'LEAN_HOGS']),
  PDBA: Object.freeze(['AGRICULTURE', 'CORN', 'SOYBEAN', 'WHEAT', 'KANSAS_WHEAT', 'SOYBEAN_OIL', 'SOYBEAN_MEAL', 'LIVE_CATTLE', 'FEEDER_CATTLE', 'LEAN_HOGS']),
});

function knownFutureExposure(row, instrumentKey) {
  if (String(row.assetClass ?? '').trim().toLowerCase() !== 'future') return null;
  const raw = String(row.future?.providerRawSymbol ?? '').trim().toUpperCase();
  const rawRoot = raw.match(/^([A-Z0-9]{1,4})[FGHJKMNQUVXZ]\d{1,2}$/)?.[1];
  if (rawRoot && FUTURE_ROOT_TO_EXPOSURE[rawRoot]) return FUTURE_ROOT_TO_EXPOSURE[rawRoot];
  // Some manual/test contracts omit the provider raw symbol. Contract IDs and
  // configured roots remain safe fallbacks because the future asset class is explicit.
  const identity = `${row.contractId ?? ''}:${row.instrumentKey ?? instrumentKey}`.toUpperCase();
  const roots = Object.keys(FUTURE_ROOT_TO_EXPOSURE).sort((a, b) => b.length - a.length);
  for (const root of roots) {
    const delimitedRoot = new RegExp(`(?:^|[^A-Z0-9])${root}(?=$|[^A-Z0-9])`).test(identity);
    const contractSuffix = new RegExp(`(?:^|[^A-Z0-9])${root}[FGHJKMNQUVXZ]\\d{1,2}$`).test(identity);
    if (delimitedRoot || contractSuffix) return FUTURE_ROOT_TO_EXPOSURE[root];
  }
  return null;
}

/** Return the stable portfolio exposure identity for current and legacy ledger rows. */
export function canonicalExposureKey(row = {}) {
  const assetClass = String(row.assetClass ?? '').trim().toLowerCase();
  if (assetClass === 'crypto' && cryptoExposureKey(row.cryptoIdentity)) return cryptoExposureKey(row.cryptoIdentity);
  const instrumentKey = String(row.instrumentKey ?? '').trim().toUpperCase();
  const configured = String(row.exposureKey ?? '').trim().toUpperCase();
  const futureExposure = knownFutureExposure(row, instrumentKey);
  if (futureExposure) return futureExposure;
  if (['etf', 'etp'].includes(assetClass) && UNDERLYING_BY_TICKER[instrumentKey]) return UNDERLYING_BY_TICKER[instrumentKey];
  // Options carry their underlying ticker as exposureKey, while instrumentKey
  // identifies the spread legs. Normalize ETF/ETP underlyings into the same
  // portfolio bucket as direct positions and the matching futures root.
  if (assetClass === 'option' && UNDERLYING_BY_TICKER[configured]) return UNDERLYING_BY_TICKER[configured];
  return configured || instrumentKey;
}

/** Return primary plus known overlapping portfolio buckets, preserving the legacy primary key. */
export function canonicalExposureKeys(row = {}) {
  const primary = canonicalExposureKey(row);
  const assetClass = String(row.assetClass ?? '').trim().toLowerCase();
  const ticker = String(row.instrumentKey ?? '').trim().toUpperCase();
  const secondary = ['etf', 'etp'].includes(assetClass) ? (SECONDARY_EXPOSURES_BY_TICKER[ticker] ?? []) : [];
  return [...new Set([primary, ...secondary].filter(Boolean))];
}

/** Resolve the direction of the underlying risk represented by a wrapper position. */
export function effectiveExposureDirection(row = {}) {
  const assetClass = String(row.assetClass ?? '').trim().toLowerCase();
  if (assetClass === 'option') {
    const underlyingDirection = String(row.underlyingDirection ?? row.researchSignal?.direction ?? '').trim().toLowerCase();
    if (['long', 'short'].includes(underlyingDirection)) return underlyingDirection;
  }
  const direction = String(row.direction ?? '').trim().toLowerCase();
  if (!['long', 'short'].includes(direction)) return null;
  const metadata = row.instrumentMetadata && typeof row.instrumentMetadata === 'object' ? row.instrumentMetadata : {};
  const inverse = ['etf', 'etp'].includes(assetClass)
    && (row.inverse === true || metadata.inverse === true || String(metadata.productType ?? '').toLowerCase() === 'inverse_etf');
  return inverse ? (direction === 'long' ? 'short' : 'long') : direction;
}

function currencyPairForExposure(row = {}) {
  const assetClass = String(row.assetClass ?? '').trim().toLowerCase();
  if (!['forex', 'future'].includes(assetClass)) return null;
  const key = assetClass === 'future' ? canonicalExposureKey(row) : String(row.instrumentKey ?? row.exposureKey ?? '');
  const pair = String(key).toUpperCase().replace(/[\/_-]/g, '');
  if (!/^[A-Z]{6}$/.test(pair) || pair.slice(0, 3) === pair.slice(3, 6)) return null;
  return { base: pair.slice(0, 3), quote: pair.slice(3, 6) };
}

/**
 * True when two different FX instruments add risk in the same direction to
 * either currency leg. Opposing leg exposure is allowed as a potential hedge.
 * This is a concentration guard, not a portfolio covariance model.
 */
export function directionalCurrencyOverlap(left = {}, right = {}) {
  const a = currencyPairForExposure(left), b = currencyPairForExposure(right);
  if (!a || !b) return [];
  const sign = (row, leg) => {
    const direction = String(row.direction ?? '').toLowerCase();
    if (!['long', 'short'].includes(direction)) return 0;
    const longSign = leg === 'base' ? 1 : -1;
    return direction === 'long' ? longSign : -longSign;
  };
  const leftLegs = new Map([[a.base, sign(left, 'base')], [a.quote, sign(left, 'quote')]]);
  return [[b.base, sign(right, 'base')], [b.quote, sign(right, 'quote')]]
    .filter(([currency, direction]) => direction !== 0 && leftLegs.get(currency) === direction)
    .map(([currency, direction]) => ({ currency, direction: direction > 0 ? 'long' : 'short' }));
}

export function sharesDirectionalCurrencyExposure(left = {}, right = {}) {
  return directionalCurrencyOverlap(left, right).length > 0;
}

export function canonicalEtfExposureKey(symbol, suppliedExposureKey) {
  const ticker = String(symbol ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) throw new Error('ETF/ETP exposure mapping requires a valid ticker.');
  if (UNDERLYING_BY_TICKER[ticker]) return UNDERLYING_BY_TICKER[ticker];
  const supplied = String(suppliedExposureKey ?? '').trim().toUpperCase();
  if (supplied && !/^[A-Z0-9][A-Z0-9:._-]{0,39}$/.test(supplied)) throw new Error(`Invalid configured exposure key for ${ticker}.`);
  return supplied || ticker;
}

export function knownEtfUnderlying(symbol) {
  return UNDERLYING_BY_TICKER[String(symbol ?? '').trim().toUpperCase()] ?? null;
}
