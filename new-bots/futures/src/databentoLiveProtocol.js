export const FUTURES_LIVE_PROTOCOL_VERSION = 'databento-live-mapped-json-v2';
const rawPattern = /^[A-Z0-9]{2,16}$/;
export const liveNumber = (value) => typeof value === 'number' ? value
  : typeof value === 'string' && /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(value.trim()) ? Number(value) : NaN;
const integer = (value, max, min = 0) => Number.isSafeInteger(liveNumber(value)) && liveNumber(value) >= min && liveNumber(value) <= max ? liveNumber(value) : null;
const raw = (value) => typeof value === 'string' && rawPattern.test(value.trim().toUpperCase()) ? value.trim().toUpperCase() : null;

export function liveTimestampNs(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return null;
  const ms = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== match[1]) return null;
  return BigInt(ms) * 1_000_000n + BigInt((match[2] || '').padEnd(9, '0'));
}
export const liveTime = (value) => { const at = liveTimestampNs(value); return at === null ? NaN : Number(at / 1_000_000n); };
const undefinedTime = (value) => value === null || value === '18446744073709551615' || value === '2554-07-21T23:34:33.709551615Z';

export function liveHeader(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Databento live record shape is invalid.');
  const header = record.hd ?? record;
  if (!header || typeof header !== 'object' || Array.isArray(header) || integer(header.rtype, 255) === null) throw new Error('Databento live record header is invalid.');
  if (record.hd && ['ts_event', 'rtype', 'publisher_id', 'instrument_id'].some((key) => record[key] != null
    && (key === 'ts_event' ? liveTimestampNs(record[key]) !== liveTimestampNs(header[key]) : liveNumber(record[key]) !== liveNumber(header[key]))))
    throw new Error('Databento live record headers conflict.');
  return { rtype: liveNumber(header.rtype), publisher: integer(header.publisher_id, 65535),
    instrument: integer(header.instrument_id, 0xffffffff), at: liveTimestampNs(header.ts_event), time: liveTime(header.ts_event) };
}

/** Resolve instrument-only records using the gateway's interval-specific raw-symbol mappings. */
export function createLiveSymbolRouter(symbols, { expectedPublishers = new Map() } = {}) {
  const requested = new Set(symbols), mappings = new Map(), mappingsBySymbol = new Map(), reasons = new Map(), publishers = new Map(), latestQuotes = new Map(), counts = {};
  const count = (key) => { counts[key] = (counts[key] || 0) + 1; };
  const reject = (symbol, reason) => { count(reason); if (requested.has(symbol)) { const list = reasons.get(symbol) || new Set(); list.add(reason); reasons.set(symbol, list); } };
  const overlap = (a, b) => (a.end === null || b.start === null || b.start < a.end) && (b.end === null || a.start === null || a.start < b.end);
  function route(record) {
    const h = liveHeader(record); count('records');
    if (h.rtype === 21) {
      count('provider_errors');
      const code = integer(record.code, 255), names = { 1: 'Authentication failed', 2: 'Key deactivated', 3: 'Connection limit exceeded',
        4: 'Symbol resolution failed', 5: 'Invalid subscription', 6: 'Internal provider error', 7: 'Skipped records', 8: 'Replay data aged out' };
      throw new Error(`Databento live provider error (code ${code ?? 'unknown'}: ${names[code] || 'Provider error'}).`);
    }
    if (h.rtype === 23) {
      count('system_messages');
      if (integer(record.code, 255) === null) throw new Error('Databento live system code is invalid.');
      if (liveNumber(record.code) === 2) throw new Error('Databento Live reported a slow-reader warning; rejecting incomplete data.');
      return { kind: 'system', code: liveNumber(record.code) };
    }
    if (h.rtype === 22) {
      const input = raw(record.stype_in_symbol), output = raw(record.stype_out_symbol);
      if (!input || !output || !h.instrument || h.publisher === null) throw new Error('Databento live symbol mapping identity is invalid.');
      if (!requested.has(input)) { count('unrequested_mapping'); return { kind: 'ignored' }; }
      if (input !== output || ['stype_in', 'stype_out'].some((key) => record[key] != null && ![1, 255].includes(liveNumber(record[key])))) {
        reject(input, 'live_mapping_not_exact_raw_symbol'); return { kind: 'ignored' };
      }
      const start = undefinedTime(record.start_ts) ? null : liveTimestampNs(record.start_ts);
      const end = undefinedTime(record.end_ts) ? null : liveTimestampNs(record.end_ts);
      if ((!undefinedTime(record.start_ts) && start === null) || (!undefinedTime(record.end_ts) && end === null)
        || (start !== null && end !== null && end <= start)) throw new Error('Databento live mapping interval is invalid.');
      const value = { symbol: output, publisher: h.publisher, instrument: h.instrument, start, end };
      const existing = mappings.get(h.instrument) || [];
      for (const prior of existing) if (prior.symbol !== output && (!prior.publisher || !h.publisher || prior.publisher === h.publisher) && overlap(prior, value)) {
        reject(prior.symbol, 'live_mapping_identity_conflict'); reject(output, 'live_mapping_identity_conflict');
      }
      const symbolMappings = mappingsBySymbol.get(output) || [];
      for (const prior of symbolMappings) if (prior.instrument !== h.instrument && overlap(prior, value))
        reject(output, 'live_symbol_instrument_conflict');
      if (!existing.some((prior) => prior.symbol === output && prior.publisher === h.publisher && prior.start === start && prior.end === end)) existing.push(value);
      if (!symbolMappings.some((prior) => prior.instrument === h.instrument && prior.publisher === h.publisher && prior.start === start && prior.end === end)) symbolMappings.push(value);
      mappingsBySymbol.set(output, symbolMappings);
      mappings.set(h.instrument, existing); count('symbol_mappings'); return { kind: 'mapping' };
    }
    if (![1, 33].includes(h.rtype)) { count('unsupported_schema'); return { kind: 'ignored' }; }
    if (!h.instrument || !h.publisher || h.at === null) throw new Error('Databento live market identity or timestamp is invalid.');
    const matching = (mappings.get(h.instrument) || []).filter((m) => (!m.publisher || m.publisher === h.publisher)
      && (m.start === null || h.at >= m.start) && (m.end === null || h.at < m.end));
    const matched = [...new Set(matching.map((m) => m.symbol))];
    if (matched.length !== 1) { count(matched.length ? 'ambiguous_mapping' : 'unmapped_record'); return { kind: 'ignored' }; }
    const symbol = matched[0];
    if (['symbol', 'raw_symbol'].some((key) => record[key] != null && raw(record[key]) !== symbol)) reject(symbol, 'live_embedded_symbol_conflict');
    const expected = expectedPublishers.get(symbol);
    if (expected !== undefined && h.publisher !== expected) reject(symbol, 'live_reviewed_publisher_mismatch');
    if (publishers.has(symbol) && publishers.get(symbol) !== h.publisher) reject(symbol, 'live_publisher_changed');
    publishers.set(symbol, h.publisher);
    if (reasons.has(symbol)) return { kind: 'rejected', symbol };
    if (h.rtype === 1) {
      const received = liveTimestampNs(record.ts_recv), sequence = integer(record.sequence, 0xffffffff);
      if (received === null) { reject(symbol, 'live_quote_receive_time_invalid'); return { kind: 'rejected', symbol }; }
      const previous = latestQuotes.get(symbol);
      if (previous && (received < previous.received || (received === previous.received && sequence !== null
        && previous.sequence !== null && sequence < previous.sequence))) { count('out_of_order_quotes'); return { kind: 'ignored' }; }
      latestQuotes.set(symbol, { received, sequence });
    }
    return { kind: h.rtype === 1 ? 'quote' : 'bar', symbol, header: h, record: { ...record,
      rtype: h.rtype, publisher_id: h.publisher, instrument_id: h.instrument, ts_event: record.hd?.ts_event ?? record.ts_event, raw_symbol: symbol } };
  }
  return { route, reasonsFor: (symbol) => [...(reasons.get(symbol) || [])], diagnostics: () => ({ version: FUTURES_LIVE_PROTOCOL_VERSION,
    ...counts, rejectionReasons: Object.fromEntries([...reasons].map(([symbol, set]) => [symbol, [...set]])) }) };
}

/** Pretty JSON MBP-1 only. Quote age is based on receive time; missing gateway timestamps are not substituted. */
export function parseLiveQuote(record, now, maxAgeMs, maxTransportLagMs) {
  const h = liveHeader(record), recvTime = liveTime(record.ts_recv), outputTime = liveTime(record.ts_out);
  const top = Array.isArray(record.levels) && record.levels.length === 1 ? record.levels[0] : null;
  const bid = liveNumber(top?.bid_px), ask = liveNumber(top?.ask_px);
  const bidSize = integer(top?.bid_sz, 0xffffffff, 1), askSize = integer(top?.ask_sz, 0xffffffff, 1), flags = integer(record.flags, 255);
  if (h.rtype !== 1 || !h.publisher || !h.instrument || ![h.time, recvTime, outputTime, bid, ask, now, maxAgeMs, maxTransportLagMs].every(Number.isFinite)
    || maxAgeMs <= 0 || maxTransportLagMs <= 0
    || flags === null || !(flags & 128) || flags & (32 | 8 | 4)
    || h.time > now + 2000 || recvTime > now + 2000 || outputTime > now + 2000
    || now - recvTime > maxAgeMs || now - outputTime > maxAgeMs || outputTime < recvTime || outputTime - recvTime > maxTransportLagMs
    || bid <= 0 || ask < bid || bidSize === null || askSize === null) return null;
  return { bid, ask, bidSize, askSize, time: new Date(recvTime).toISOString(), quality: 'executable' };
}

export function normalizeLiveMinuteBar(record, symbol) {
  const h = liveHeader(record);
  const bar = { timestamp: h.time, open: liveNumber(record.open), high: liveNumber(record.high), low: liveNumber(record.low),
    close: liveNumber(record.close), volume: liveNumber(record.volume) };
  if (h.rtype !== 33 || raw(record.raw_symbol ?? record.symbol) !== symbol || !Number.isFinite(h.time) || h.at % 60_000_000_000n !== 0n
    || ![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) || !Number.isSafeInteger(bar.volume)
    || bar.low <= 0 || bar.volume <= 0 || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close, bar.low)) return null;
  return bar;
}
