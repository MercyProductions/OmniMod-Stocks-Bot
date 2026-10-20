import { mergeEtfDirectories, NASDAQ_ETF_DIRECTORY_URLS, parseNasdaqEtfDirectory } from '../../shared/nasdaqEtfDirectory.js';
import { parseSupplementalEtpRegistryDetailed } from '../../shared/etpClassification.js';

export { mergeEtfDirectories, NASDAQ_ETF_DIRECTORY_URLS, parseNasdaqEtfDirectory };
export { parseSupplementalEtpRegistry, parseSupplementalEtpRegistryDetailed } from '../../shared/etpClassification.js';

export const CURATED_ETF_SEEDS = [
  'SPY','QQQ','IWM','DIA','VTI','VOO','RSP','MDY','IWC','ARKK',
  'XLF','XLK','XLE','XLV','XLI','XLY','XLP','XLU','XLC','XLB','XLRE','SMH','SOXX','XBI','KRE',
  'TLT','IEF','SHY','HYG','LQD','JNK','TIP','BND','AGG','MUB',
  'GLD','IAU','SLV','USO','USL','BNO','UNG','UNL','UGA','USCI','CPER','DBA','PDBA','PDBC','DBC','DJP','UCO','SCO','BOIL','KOLD','AGQ','ZSL',
  'TQQQ','SQQQ','UPRO','SPXU','SOXL','SOXS','LABU','LABD','UVXY','SVIX','NVDL','NVD',
  'IBIT','FBTC','BITO','ETHE','ETHA','BITX','YINN','YANG','TMF','TMV',
];

/**
 * Parse a locally maintained, source-cited classification file for exchange-listed
 * ETP wrappers (for example ETNs not represented by the exchange ETF flag).
 * Rows are intentionally strict: names and ticker patterns are never classifiers.
 */
export function refreshSupplementalEtpReviews(entries, { now = new Date(), maxReviewAgeDays = 180 } = {}) {
  const rows = Array.isArray(entries) ? entries : [];
  const exchangeFunds = rows.filter((row) => row?.source !== 'supplemental-reviewed');
  const { entries: supplemental, blockedSymbols } = parseSupplementalEtpRegistryDetailed(rows.filter((row) => row?.source === 'supplemental-reviewed'), { now, maxReviewAgeDays });
  const blocked = new Set(blockedSymbols);
  const bySymbol = new Map(exchangeFunds.filter((row) => !blocked.has(row.symbol)).map((row) => [row.symbol, row]));
  for (const row of supplemental) bySymbol.set(row.symbol, row);
  return { entries: [...bySymbol.values()], supplementalCount: supplemental.length, blockedSymbols: [...blocked] };
}

/** Conservative safety screen only: name markers can block a suspected wrapper, never establish that it is 1x or approve it. */
export function hasUnreviewedLeverageMarker(name = '') {
  const value = String(name || '').trim();
  const explicit = /\b(?:leveraged|inverse|[2-5]\s*x|1[.,]\d+\s*x|daily\s+(?:bull|bear)|bull\s*[1-5]?\s*x|bear\s*[1-5]?\s*x|1\s*x\s+short)\b/i.test(value);
  const issuerProduct = /\bproshares\s+(?:ultra(?:pro|short)?|short)\b/i.test(value);
  const ultraProduct = /\bultra(?:pro|short)?\b/i.test(value);
  const namedBenchmark = /\b(?:s&p|nasdaq|dow|russell|semiconductor|biotech|gold|silver|crude|oil|natural\s+gas|bitcoin|btc|vix|currency|euro|yen)\b|\b(?:20\+|7\s*-\s*10)\s*(?:year|yr)\b/i.test(value);
  return explicit || issuerProduct || (ultraProduct && namedBenchmark);
}

/** An ETF-directory flag does not turn an exchange-traded note into an ordinary fund. */
export function hasUnreviewedEtnMarker(name = '') {
  return /\bETNs?\b|\bexchange[ -]traded\s+notes?\b/i.test(String(name || ''));
}

export function parseScreenerSymbols(payload) {
  const rows = [
    ...(Array.isArray(payload?.most_actives) ? payload.most_actives : []),
    ...(Array.isArray(payload?.gainers) ? payload.gainers : []),
    ...(Array.isArray(payload?.losers) ? payload.losers : []),
    ...(Array.isArray(payload?.movers?.gainers) ? payload.movers.gainers : []),
    ...(Array.isArray(payload?.movers?.losers) ? payload.movers.losers : []),
  ];
  return [...new Set(rows.map((row) => String(row?.symbol || '').trim().toUpperCase()).filter((symbol) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)))];
}

export function selectEtfDiscoveryCandidates({ registry, screenerSymbols, curatedSymbols = CURATED_ETF_SEEDS, maxCandidates = 200, blockedSymbols = [] }) {
  const registered = new Set(registry.map((entry) => entry.symbol));
  const blocked = new Set(blockedSymbols);
  const discovered = screenerSymbols.filter((symbol) => registered.has(symbol) && !blocked.has(symbol));
  const cap = Number.isFinite(Number(maxCandidates)) ? Math.max(1, Math.min(200, Math.floor(Number(maxCandidates)))) : 200;
  const candidates = [...new Set([...curatedSymbols.filter((symbol) => registered.has(symbol) && !blocked.has(symbol)), ...discovered])].slice(0, cap);
  return { candidates, screenerEtfs: discovered.length, curatedEtfs: curatedSymbols.filter((symbol) => registered.has(symbol)).length };
}

