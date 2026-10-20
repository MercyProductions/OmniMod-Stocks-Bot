const NASDAQ_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt';
const OTHER_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt';

export const NASDAQ_ETF_DIRECTORY_URLS = Object.freeze({ nasdaq: NASDAQ_LISTED_URL, other: OTHER_LISTED_URL });

export const ETF_DIRECTORY_INSPECTION_VERSION = 'nasdaq-etf-directory-audit-v1';
// F is corroborated by TXSE's SIP code specification and observed primary ETF listings.
const EXCHANGES = { A: 'AMEX', N: 'NYSE', P: 'ARCA', Z: 'BATS', V: 'IEX', F: 'TXSE' };

function creationTime(line) {
  const match = String(line || '').match(/^File Creation Time:\s*(\d{2})(\d{2})(\d{4})(\d{2}):?(\d{2})\|/i);
  if (!match) return null;
  const [, month, day, year, hour, minute] = match;
  const local = `${year}-${month}-${day}T${hour}:${minute}:00`;
  const date = new Date(local + 'Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== local) return null;
  // The documented footer has no UTC offset. Preserve its clock text without inventing UTC.
  return { raw: match[0].slice(0, -1), local, timeZone: null, timestampBasis: 'provider_local_time_zone_unspecified' };
}

/** Inspect every row, including rows unsupported by the current downstream adapter. */
export function inspectNasdaqEtfDirectory(text, kind) {
  if (!['nasdaq', 'other'].includes(kind)) throw new Error('Unknown Nasdaq directory type.');
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  const headers = (lines.shift() || '').split('|').map(field => field.trim().toLowerCase());
  const symbolIndex = headers.indexOf(kind === 'nasdaq' ? 'symbol' : 'act symbol');
  const nameIndex = headers.indexOf('security name'), etfIndex = headers.indexOf('etf');
  const testIndex = headers.indexOf('test issue'), exchangeIndex = kind === 'other' ? headers.indexOf('exchange') : -1;
  if ([symbolIndex, nameIndex, etfIndex, testIndex].some(index => index < 0)
    || (kind === 'other' && exchangeIndex < 0) || new Set(headers).size !== headers.length) {
    throw new Error(`Unexpected Nasdaq ${kind} directory schema.`);
  }
  const footerLines = lines.filter(line => /^file creation time:/i.test(line));
  const generated = creationTime(lines.at(-1));
  const footerFields = String(lines.at(-1) || '').split('|');
  // The actual otherlisted file omits the trailing Nasdaq Symbol footer delimiter.
  // Accept that observed legacy trailer form, without relaxing security-row width.
  const legacyOtherTrailer = kind === 'other' && headers.at(-1) === 'nasdaq symbol' && footerFields.length === headers.length - 1;
  const footerComplete = footerLines.length === 1 && generated !== null && (footerFields.length === headers.length || legacyOtherTrailer)
    && footerFields.slice(1).every(field => !field.trim());
  const rows = [], groups = new Map();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^file creation time:/i.test(line)) continue;
    const fields = line.split('|'), symbol = String(fields[symbolIndex] || '').trim().toUpperCase();
    const name = String(fields[nameIndex] || '').trim();
    const etfFlag = String(fields[etfIndex] || '').trim().toUpperCase(), testFlag = String(fields[testIndex] || '').trim().toUpperCase();
    const exchangeCode = kind === 'nasdaq' ? 'NASDAQ' : String(fields[exchangeIndex] || '').trim().toUpperCase();
    const exchange = kind === 'nasdaq' ? 'NASDAQ' : EXCHANGES[exchangeCode] || 'UNKNOWN';
    const reason = fields.length !== headers.length ? 'malformed_row_width'
      : !['Y', 'N'].includes(etfFlag) || !['Y', 'N'].includes(testFlag) ? 'invalid_classification_flag'
        : testFlag === 'Y' ? 'test_issue' : etfFlag === 'N' ? 'not_etf_flagged'
          : !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) ? 'unsupported_symbol_format'
            : !name ? 'missing_security_name' : exchange === 'UNKNOWN' ? 'unknown_exchange_code'
              : exchange === 'IEX' ? 'unsupported_listing' : null;
    const row = { line: index + 2, symbol, name, etfFlag, testFlag, exchangeCode, exchange, reason };
    rows.push(row);
    if (symbol && fields.length === headers.length) {
      const group = groups.get(symbol) || []; group.push(row); groups.set(symbol, group);
    }
  }
  const conflicts = [];
  for (const [symbol, group] of groups) if (group.length > 1) {
    const identities = new Set(group.map(row => JSON.stringify([row.name, row.etfFlag, row.testFlag, row.exchangeCode])));
    if (identities.size > 1) { conflicts.push(symbol); for (const row of group) row.reason = 'conflicting_symbol_rows'; }
    else for (const row of group.slice(1)) row.reason = 'duplicate_row';
  }
  const entries = rows.filter(row => !row.reason).map(({ symbol, name, exchange }) => ({ symbol, name, exchange, instrumentType: 'etf', source: kind }));
  const reasons = {}, byExchangeCode = Object.create(null);
  for (const row of rows) {
    reasons[row.reason || 'accepted'] = (reasons[row.reason || 'accepted'] || 0) + 1;
    byExchangeCode[row.exchangeCode || 'missing'] = (byExchangeCode[row.exchangeCode || 'missing'] || 0) + 1;
  }
  return { entries, rows, createdAt: null, creationTime: generated,
    diagnostics: { version: ETF_DIRECTORY_INSPECTION_VERSION, kind, providerRows: rows.length,
      uniqueSymbols: groups.size, etfFlaggedRows: rows.filter(row => row.etfFlag === 'Y').length,
      acceptedUniqueEtfs: entries.length, excludedRows: rows.length - entries.length,
      conflictingSymbols: conflicts, reasons, byExchangeCode,
      footerComplete, footerFieldCount: footerFields.length, legacyOtherTrailer,
      enumeration: footerComplete ? 'complete_file_received' : 'footer_missing_or_invalid',
      identityIntegrity: conflicts.length ? 'conflicting_symbol_rows' : 'no_duplicate_identity_conflict_observed',
      activeOrTradable: 'unknown_without_account_and_market_data' } };
}

/** Existing adapters retain their listing/symbol scope; ambiguous identities fail closed. */
export function parseNasdaqEtfDirectory(text, kind) {
  const result = inspectNasdaqEtfDirectory(text, kind);
  if (!result.diagnostics.footerComplete) throw new Error(`Nasdaq ${kind} directory is missing a valid terminal creation marker.`);
  if (result.diagnostics.conflictingSymbols.length) throw new Error(`Nasdaq ${kind} directory has conflicting symbol identities.`);
  if (['malformed_row_width', 'invalid_classification_flag', 'missing_security_name'].some(reason => result.diagnostics.reasons[reason])) {
    throw new Error(`Nasdaq ${kind} directory contains malformed security rows.`);
  }
  if (!result.entries.length) throw new Error(`Nasdaq ${kind} directory contained no eligible ETF rows.`);
  return { entries: result.entries, createdAt: result.createdAt, creationTime: result.creationTime, diagnostics: result.diagnostics };
}

export function mergeEtfDirectories(nasdaqText, otherText) {
  const nasdaq = parseNasdaqEtfDirectory(nasdaqText, 'nasdaq');
  const other = parseNasdaqEtfDirectory(otherText, 'other');
  const bySymbol = new Map();
  for (const row of [...other.entries, ...nasdaq.entries]) {
    if (bySymbol.has(row.symbol)) throw new Error('Nasdaq directories contain an ambiguous cross-file ETF identity.');
    bySymbol.set(row.symbol, row);
  }
  return { entries: [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)),
    sources: { nasdaqCreatedAt: nasdaq.createdAt, otherCreatedAt: other.createdAt,
      nasdaqCreationTime: nasdaq.creationTime, otherCreationTime: other.creationTime },
    directoryInspection: { nasdaq: nasdaq.diagnostics, other: other.diagnostics } };
}
