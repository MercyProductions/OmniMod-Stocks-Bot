import { inspectActiveFutureContract } from './universe.js';

export const FUTURES_H1_VERSION = 'databento-h1-wire-v2';
export const HOUR_MS = 3_600_000;
const rawPattern = /^[A-Z0-9]{2,16}$/;
const decimal = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i;
const number = (value) => typeof value === 'number' ? value
  : typeof value === 'string' && decimal.test(value.trim()) ? Number(value) : NaN;
const id = (value, max) => Number.isSafeInteger(number(value)) && number(value) > 0 && number(value) <= max ? number(value) : null;
const raw = (value) => typeof value === 'string' && rawPattern.test(value.trim().toUpperCase()) ? value.trim().toUpperCase() : null;
const timestamp = (value) => {
  const at = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 19) === value.slice(0, 19) ? at : NaN;
};
const increment = (map, key) => map.set(key, (map.get(key) || 0) + 1);

export function validateH1Policy({ now, minBars = 50, maxBars = 200 }) {
  if (!Number.isFinite(now) || !Number.isInteger(minBars) || minBars < 50 || minBars > 500
    || !Number.isInteger(maxBars) || maxBars < minBars || maxBars > 500) throw new RangeError('H1 policy requires a finite clock and 50–500 bars with maxBars >= minBars.');
}

export function inspectH1Contract(row, { now, dataset }) {
  const inspected = inspectActiveFutureContract(row?.contract, { now });
  const reasons = [...inspected.reasons];
  if (!raw(row?.contract?.providerRawSymbol)) reasons.push('provider_raw_symbol_missing_or_invalid');
  if (row?.contract?.providerDataset != null && row.contract.providerDataset !== dataset) reasons.push('h1_contract_dataset_mismatch');
  if (row?.contract?.providerPublisherId != null && id(row.contract.providerPublisherId, 65535) === null) reasons.push('h1_contract_publisher_invalid');
  return { valid: !reasons.length, reasons: [...new Set(reasons)] };
}

/** Decode only explicitly requested pretty JSON. Never infer units from price magnitude. */
export function normalizeH1History(dayTrades, records, { now = Date.now(), minBars = 50, maxBars = 200,
  dataset = 'GLBX.MDP3', start = null, end = null } = {}) {
  if (!Array.isArray(dayTrades) || !Array.isArray(records)) throw new TypeError('Futures rows and Databento H1 records must be arrays.');
  validateH1Policy({ now, minBars, maxBars });
  const startAt = start === null ? -Infinity : Date.parse(start), endAt = end === null ? Infinity : Date.parse(end);
  if (Number.isNaN(startAt) || Number.isNaN(endAt) || startAt >= endAt) throw new RangeError('Invalid H1 requested interval.');
  const symbols = new Map(dayTrades.map((row) => [raw(row?.contract?.providerRawSymbol), { bars: new Map(), reasons: new Set(), publishers: new Set() }]).filter(([symbol]) => symbol));
  const counts = new Map(), identitySymbols = new Map(), symbolIdentities = new Map(), unassignedReasons = new Set();
  const reject = (symbol, reason) => { increment(counts, reason); symbols.get(symbol)?.reasons.add(reason); };
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) { increment(counts, 'h1_invalid_record_shape'); unassignedReasons.add('h1_invalid_record_shape'); continue; }
    const mapped = raw(record.symbol), native = raw(record.raw_symbol), symbol = native || mapped;
    if (record.raw_symbol != null && record.symbol != null && (!native || !mapped || native !== mapped)) {
      reject(native, 'h1_symbol_mapping_conflict'); if (mapped !== native) reject(mapped, 'h1_symbol_mapping_conflict'); continue;
    }
    if (!symbol) { increment(counts, 'h1_symbol_mapping_missing'); unassignedReasons.add('h1_symbol_mapping_missing'); continue; }
    const state = symbols.get(symbol);
    const header = record.hd == null ? record : record.hd;
    if (!header || typeof header !== 'object' || Array.isArray(header)) { reject(symbol, 'h1_invalid_header'); continue; }
    const at = timestamp(header.ts_event), publisher = id(header.publisher_id, 65535), instrument = id(header.instrument_id, 0xffffffff);
    if (record.hd && ['ts_event', 'rtype', 'publisher_id', 'instrument_id'].some((key) => record[key] != null
      && (key === 'ts_event' ? timestamp(record[key]) !== timestamp(header[key]) : number(record[key]) !== number(header[key])))) {
      reject(symbol, 'h1_header_conflict'); continue;
    }
    if (number(header.rtype) !== 34) { reject(symbol, 'h1_schema_mismatch'); continue; }
    if (publisher === null || instrument === null) { reject(symbol, 'h1_identity_missing_or_invalid'); continue; }
    if (!Number.isFinite(at) || at % HOUR_MS !== 0) { reject(symbol, 'h1_timestamp_invalid_or_unaligned'); continue; }
    if (at < startAt || at >= endAt) { reject(symbol, 'h1_bar_outside_requested_range'); continue; }
    if (at + HOUR_MS > now) { increment(counts, 'h1_bar_not_completed'); continue; }
    // IDs are scoped to a UTC date. Changes on another date are valid; same-day ambiguity is not.
    const date = new Date(at).toISOString().slice(0, 10), identity = `${date}:${publisher}:${instrument}`, symbolDate = `${date}:${symbol}`;
    const priorSymbol = identitySymbols.get(identity), priorIdentity = symbolIdentities.get(symbolDate);
    if (priorSymbol && priorSymbol !== symbol) { reject(priorSymbol, 'h1_identity_symbol_conflict'); reject(symbol, 'h1_identity_symbol_conflict'); }
    else identitySymbols.set(identity, symbol);
    if (priorIdentity && priorIdentity !== identity) reject(symbol, 'h1_ambiguous_symbol_identity');
    else symbolIdentities.set(symbolDate, identity);
    if (!state) { increment(counts, 'h1_unrequested_symbol'); continue; }
    state.publishers.add(publisher);
    // pretty_px=true supplies display prices in the original field names, not fixed-point integers.
    const open = number(record.open), high = number(record.high), low = number(record.low), close = number(record.close), volume = number(record.volume);
    if (![open, high, low, close].every(Number.isFinite) || !Number.isSafeInteger(volume) || volume <= 0
      || low > Math.min(open, close) || high < Math.max(open, close, low)) { reject(symbol, 'h1_ohlcv_invalid'); continue; }
    // Discovery retains zero/negative prices. The existing ORB strategy requires strictly positive bars.
    if (low <= 0) { reject(symbol, 'h1_nonpositive_price_strategy_ineligible'); continue; }
    const bar = { time: new Date(at).toISOString(), open, high, low, close, volume };
    const previous = state.bars.get(at);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(bar)) reject(symbol, 'h1_conflicting_duplicate_bar');
      else increment(counts, 'h1_identical_duplicate_bar');
    } else { state.bars.set(at, bar); increment(counts, 'h1_accepted_bar'); }
  }
  const rows = dayTrades.map((row) => {
    const symbol = raw(row?.contract?.providerRawSymbol), state = symbols.get(symbol);
    const contract = inspectH1Contract(row, { now, dataset });
    const values = [...(state?.bars.values() || [])].sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).slice(-maxBars);
    const latest = values.length ? Date.parse(values.at(-1).time) + HOUR_MS : NaN;
    const fresh = Number.isFinite(latest) && latest <= now && now - latest <= 65 * 60_000;
    const reasons = new Set([...(state?.reasons || []), ...unassignedReasons]);
    if (!contract.valid) { reasons.add('verified_active_contract_metadata_invalid'); contract.reasons.forEach((reason) => reasons.add(reason)); }
    if (state?.publishers.size > 1) reasons.add('h1_publisher_changed');
    if (row?.contract?.providerPublisherId != null && [...(state?.publishers || [])].some((publisher) => publisher !== number(row.contract.providerPublisherId))) reasons.add('h1_contract_publisher_mismatch');
    if (values.length < minBars) reasons.add('h1_history_insufficient');
    if (!fresh) reasons.add('h1_history_stale_or_missing');
    let gaps = 0;
    for (let i = 1; i < values.length; i++) gaps += Math.max(0, (Date.parse(values[i].time) - Date.parse(values[i - 1].time)) / HOUR_MS - 1);
    return { ...row, trendBars: reasons.size ? [] : values, trendDataStatus: reasons.size ? 'incomplete' : 'complete',
      trendDataReasons: [...reasons], trendDataProvider: `Databento ${dataset} ohlcv-1h`, trendDataVersion: FUTURES_H1_VERSION,
      trendDataBars: values.length, trendDataMissingIntervals: gaps,
      trendDataAsOf: Number.isFinite(latest) ? new Date(latest).toISOString() : null };
  });
  const rejectionCounts = new Map();
  for (const row of rows) for (const reason of row.trendDataReasons) increment(rejectionCounts, reason);
  return { rows, diagnostics: { version: FUTURES_H1_VERSION, records: records.length,
    recordDispositions: Object.fromEntries(counts), rejectionReasons: Object.fromEntries(rejectionCounts),
    note: 'Missing intervals are retained as missing; scheduled closures are not inferred or zero-filled.' } };
}
