import { createHash } from 'node:crypto';
import net from 'node:net';
import { inspectActiveFutureContract } from './universe.js';
import { createLiveSymbolRouter, liveNumber, liveTime as providerTime, normalizeLiveMinuteBar as normalizeOneMinuteBar, parseLiveQuote as parseQuote } from './databentoLiveProtocol.js';

const LIVE_PORT = 13_000;
const FIVE_MINUTES = 5 * 60_000;

/** Aggregate only five consecutive complete one-minute provider bars from the configured session open. */
export function aggregateDatabentoFiveMinuteBars(records, rawSymbol, session, { now = Date.now() } = {}) {
  const open = providerTime(session?.openTime), close = providerTime(session?.closeTime);
  if (!Number.isFinite(open) || !Number.isFinite(close) || close <= open) return [];
  const minuteBars = records.map((record) => normalizeOneMinuteBar(record, rawSymbol))
    .filter((bar) => bar && bar.timestamp >= open && bar.timestamp < close && bar.timestamp + 60_000 <= now)
    .sort((a, b) => a.timestamp - b.timestamp);
  const buckets = new Map();
  for (const bar of minuteBars) {
    const start = open + Math.floor((bar.timestamp - open) / 60_000) * 60_000;
    const group = open + Math.floor((start - open) / FIVE_MINUTES) * FIVE_MINUTES;
    const rows = buckets.get(group) ?? [];
    rows.push({ ...bar, timestamp: start }); buckets.set(group, rows);
  }
  const result = [];
  for (const [time, rows] of [...buckets].sort((a, b) => a[0] - b[0])) {
    if (rows.length !== 5 || rows.some((bar, i) => bar.timestamp !== time + i * 60_000)) continue;
    result.push({ time: new Date(time).toISOString(), open: rows[0].open,
      high: Math.max(...rows.map((bar) => bar.high)), low: Math.min(...rows.map((bar) => bar.low)),
      close: rows.at(-1).close, volume: rows.reduce((sum, bar) => sum + bar.volume, 0) });
  }
  return result;
}

/**
 * Fetch completed 1m bars replayed since each configured session's opening and
 * one fresh executable MBP-1 quote. Contracts and session/catalyst/trend inputs
 * remain caller-verified. This read-only adapter never places orders.
 */
export async function fetchDatabentoFuturesDayMarketData(dayTrades, {
  apiKey = '', dataset = 'GLBX.MDP3', now = Date.now(), maxQuoteAgeMs = 5_000,
  maxTransportLagMs = 2_000, timeoutMs = 30_000, minBookSize = 1,
  metrics = [], clock = Date.now, connect = (options) => net.connect(options),
} = {}) {
  if (!Array.isArray(dayTrades)) throw new TypeError('Futures day-trade rows must be an array.');
  if (!Array.isArray(metrics)) throw new TypeError('Provider metrics must be an array.');
  if (!dayTrades.length) return { rows: [], diagnostics: { status: 'no_day_trades', requested: 0, received: 0 } };
  const rows = dayTrades.map((row) => {
    const contract = row?.contract ?? {};
    const rawSymbol = String(contract.providerRawSymbol ?? '').trim().toUpperCase();
    const open = providerTime(row?.session?.openTime), close = providerTime(row?.session?.closeTime);
    const reasons = [];
    const contractInspection = inspectActiveFutureContract(contract, { now });
    if (contract.providerDataset != null && contract.providerDataset !== dataset) reasons.push('reviewed_contract_dataset_mismatch');
    if (contract.providerPublisherId != null && (!Number.isInteger(liveNumber(contract.providerPublisherId))
      || liveNumber(contract.providerPublisherId) < 1 || liveNumber(contract.providerPublisherId) > 65535)) reasons.push('reviewed_contract_publisher_invalid');
    if (!/^[A-Z0-9]{2,16}$/.test(rawSymbol) || !contractInspection.valid) reasons.push('verified_active_contract_metadata_invalid', ...contractInspection.reasons);
    if (!Number.isFinite(open) || !Number.isFinite(close) || open >= close || open > now || now >= close) reasons.push('valid_open_exchange_session_required');
    if (Number.isFinite(open) && now - open > 24 * 60 * 60_000) reasons.push('session_open_outside_live_replay_window');
    return { ...row, _liveRawSymbol: rawSymbol, _liveOpen: open, _liveReasons: reasons };
  });
  const reviewedPublishers = new Map();
  for (const row of rows.filter((r) => !r._liveReasons.length && r.contract.providerPublisherId != null)) {
    const set = reviewedPublishers.get(row._liveRawSymbol) || new Set();
    set.add(liveNumber(row.contract.providerPublisherId)); reviewedPublishers.set(row._liveRawSymbol, set);
  }
  for (const row of rows) if (reviewedPublishers.get(row._liveRawSymbol)?.size > 1) row._liveReasons.push('reviewed_contract_publisher_conflict');
  const eligible = rows.filter((row) => !row._liveReasons.length);
  const metadataRejected = rows.filter((row) => row._liveReasons.includes('verified_active_contract_metadata_invalid')).length;
  const preflightReasonCounts = new Map();
  for (const row of rows) for (const reason of row._liveReasons) preflightReasonCounts.set(reason, (preflightReasonCounts.get(reason) || 0) + 1);
  const preflightRejectionReasons = Object.fromEntries([...preflightReasonCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  const symbols = [...new Set(eligible.map((row) => row._liveRawSymbol))];
  if (!apiKey) return { rows: rows.map(({ _liveRawSymbol, _liveOpen, _liveReasons, ...row }) => ({ ...row,
    liveDataStatus: _liveReasons.includes('verified_active_contract_metadata_invalid') ? 'contract_or_session_unavailable' : 'credentials_missing',
    quote: null, bars: [], liveDataReasons: _liveReasons.includes('verified_active_contract_metadata_invalid') ? _liveReasons : ['databento_credentials_missing'] })),
  diagnostics: { status: 'credentials_missing', requested: rows.length, eligible: eligible.length, metadataRejected, preflightRejectionReasons, symbols: symbols.length, received: 0 } };
  if (!/^[A-Z0-9.]{3,24}$/.test(dataset)) throw new TypeError('Invalid Databento dataset identifier.');
  if (![now, maxQuoteAgeMs, maxTransportLagMs, timeoutMs, minBookSize].every(Number.isFinite) || maxQuoteAgeMs <= 0 || maxTransportLagMs <= 0 || timeoutMs <= 0 || minBookSize <= 0) throw new RangeError('Databento live day-data limits must be positive and now must be finite.');
  if (!symbols.length) return { rows: rows.map(({ _liveRawSymbol, _liveOpen, ...row }) => ({ ...row, quote: null, bars: [], liveDataStatus: 'contract_or_session_unavailable', liveDataReasons: row._liveReasons })),
    diagnostics: { status: 'contract_or_session_unavailable', requested: rows.length, eligible: 0, metadataRejected, preflightRejectionReasons, symbols: 0, received: 0 } };
  if (symbols.length > 100) return { rows: dayTrades.map((row) => ({ ...row, quote: null, bars: [], liveDataStatus: 'symbol_limit_exceeded' })), diagnostics: { status: 'symbol_limit_exceeded', requested: rows.length, symbols: symbols.length, received: 0 } };
  const replayStart = new Date(Math.min(...eligible.map((row) => row._liveOpen))).toISOString();
  const output = new Map(symbols.map((symbol) => [symbol, { quote: null, bars: new Map(), reasons: new Set() }]));
  const router = createLiveSymbolRouter(symbols, { expectedPublishers: new Map(eligible.filter((r) => r.contract.providerPublisherId != null)
    .map((r) => [r._liveRawSymbol, liveNumber(r.contract.providerPublisherId)])) });
  const clockStart = clock(), observedNow = () => now + Math.max(0, clock() - clockStart);
  const startedAt = Date.now();
  const host = `${dataset.toLowerCase().replaceAll('.', '-')}.lsg.databento.com`;
  let socket, buffer = '', phase = 'greeting', records = 0, settled = false, timer, replayCompleted = false, bytes = 0;
  const finish = (resolve, rejectPromise, error = null) => {
    if (settled) return;
    settled = true; clearTimeout(timer); socket?.destroy();
    const finalNow = observedNow();
    const quoted = [...output.entries()].filter(([symbol, row]) => row.quote && !router.reasonsFor(symbol).length && parseQuote(row.quote, finalNow, maxQuoteAgeMs, maxTransportLagMs)).length;
    const operations = { 'ohlcv-1m-session-bars': { records: [...output.values()].reduce((sum, row) => sum + row.bars.size, 0), status: error ? 0 : 200 },
      'mbp-1-entry-quotes': { records, quotedSymbols: quoted, requestedSymbols: symbols.length, status: error ? 0 : quoted === symbols.length ? 200 : 408 },
      'ohlcv-1m-replay': { replayCompleted, status: error ? 0 : replayCompleted ? 200 : 408 } };
    for (const [operation, values] of Object.entries(operations)) metrics.push({ provider: 'Databento Live', operation, latencyMs: Math.max(0, Date.now() - startedAt), ...values,
      ...(error ? { error: String(error.message || error).slice(0, 180) } : {}) });
    if (error) { rejectPromise(error); return; }
    const resultRows = rows.map((row) => {
      const { _liveRawSymbol, _liveOpen, _liveReasons, ...clean } = row;
      const observed = output.get(_liveRawSymbol);
      const quote = observed?.quote ? parseQuote(observed.quote, finalNow, maxQuoteAgeMs, maxTransportLagMs) : null;
      const bars = _liveRawSymbol ? aggregateDatabentoFiveMinuteBars([...(observed?.bars.values() ?? [])], _liveRawSymbol, row.session, { now: finalNow }) : [];
      const reasons = [..._liveReasons, ...router.reasonsFor(_liveRawSymbol), ...(observed?.reasons ?? [])];
      if (!inspectActiveFutureContract(row.contract, { now: finalNow }).valid) reasons.push('contract_became_invalid_during_collection');
      if (finalNow >= providerTime(row.session?.closeTime)) reasons.push('session_closed_during_collection');
      if (!replayCompleted && _liveRawSymbol) reasons.push('provider_replay_incomplete');
      if (_liveRawSymbol && !quote) reasons.push('fresh_executable_live_quote_unavailable');
      if (_liveRawSymbol && !bars.length) reasons.push('complete_session_bars_unavailable');
      if (quote && (quote.bidSize < minBookSize || quote.askSize < minBookSize)) reasons.push('displayed_top_book_size_below_minimum');
      const tick = liveNumber(row.contract?.tickSize), aligned = (price) => Number.isFinite(tick) && tick > 0 && Math.abs(price / tick - Math.round(price / tick)) <= 1e-6;
      if (quote && (!aligned(quote.bid) || !aligned(quote.ask))) reasons.push('quote_off_verified_contract_tick');
      return { ...clean, quote: reasons.length ? null : quote, bars: reasons.length ? [] : bars,
        liveDataStatus: reasons.length ? 'incomplete' : 'complete', liveDataReasons: reasons,
        liveProvider: `Databento Live ${dataset}`, liveReplayStart: replayStart };
    });
    resolve({ rows: resultRows, diagnostics: { status: resultRows.every((row) => row.liveDataStatus === 'complete') ? 'complete' : 'partial',
      requested: rows.length, eligible: eligible.length, metadataRejected, preflightRejectionReasons, symbols: symbols.length, quoted, bars: resultRows.reduce((sum, row) => sum + row.bars.length, 0), records, replayStart, replayCompleted, dataset,
      protocol: router.diagnostics(), evaluatedAt: new Date(finalNow).toISOString() } });
  };
  return await new Promise((resolve, rejectPromise) => {
    timer = setTimeout(() => finish(resolve, rejectPromise), timeoutMs);
    try { socket = connect({ host, port: LIVE_PORT }); }
    catch (error) { finish(resolve, rejectPromise, error); return; }
    socket.setTimeout?.(timeoutMs, () => finish(resolve, rejectPromise, new Error('Databento live day-data timeout.')));
    socket.on('error', (error) => finish(resolve, rejectPromise, error));
    socket.on('close', () => { if (!settled) finish(resolve, rejectPromise, new Error('Databento live session closed before completion.')); });
    socket.on('data', (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > 128 * 1024 * 1024) { finish(resolve, rejectPromise, new Error('Databento live session byte limit exceeded.')); return; }
      buffer += chunk.toString('utf8');
      if (buffer.length > 32 * 1024 * 1024) { finish(resolve, rejectPromise, new Error('Databento live session buffer exceeded its safety limit.')); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0 && !settled) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (phase !== 'stream') {
          const fields = Object.fromEntries(line.split('|').map((field) => { const i = field.indexOf('='); return i < 0 ? [field, ''] : [field.slice(0, i), field.slice(i + 1)]; }));
          if (fields.cram) {
            const response = createHash('sha256').update(`${fields.cram}|${apiKey}`).digest('hex');
            const bucket = Buffer.from(apiKey, 'utf8').subarray(-5).toString('utf8');
            socket.write(`auth=${response}-${bucket}|dataset=${dataset}|encoding=json|compression=none|ts_out=1|pretty_px=1|pretty_ts=1|heartbeat_interval_s=10|slow_reader_behavior=warn\n`);
            phase = 'auth-response';
          } else if (fields.success === '1' && phase === 'auth-response') {
            socket.write(`schema=ohlcv-1m|stype_in=raw_symbol|symbols=${symbols.join(',')}|start=${replayStart}|id=1\n`);
            socket.write(`schema=mbp-1|stype_in=raw_symbol|symbols=${symbols.join(',')}|id=2\n`);
            socket.write('start_session=0\n'); phase = 'stream';
          } else if (fields.success === '0' || fields.error) finish(resolve, rejectPromise, new Error('Databento live gateway rejected authentication.'));
          continue;
        }
        let record;
        try { record = JSON.parse(line); } catch { finish(resolve, rejectPromise, new Error('Databento live session returned malformed JSON.')); continue; }
        records++;
        if (records > 250_000) { finish(resolve, rejectPromise, new Error('Databento live session record limit exceeded.')); continue; }
        let routed;
        try { routed = router.route(record); } catch (error) { finish(resolve, rejectPromise, error); continue; }
        if (routed.kind === 'system' && routed.code === 3) { replayCompleted = true; continue; }
        const target = output.get(routed.symbol); if (!target) continue;
        if (routed.kind === 'quote') target.quote = parseQuote(routed.record, observedNow(), maxQuoteAgeMs, maxTransportLagMs) ? routed.record : null;
        else if (routed.kind === 'bar') {
          const bar = normalizeOneMinuteBar(routed.record, routed.symbol);
          if (!bar) { target.reasons.add('live_minute_bar_invalid'); continue; }
          const previous = target.bars.get(bar.timestamp);
          if (previous && JSON.stringify(normalizeOneMinuteBar(previous, routed.symbol)) !== JSON.stringify(bar)) target.reasons.add('live_minute_bar_conflict');
          else target.bars.set(bar.timestamp, routed.record);
        }
      }
      // Drain the current packet before accepting: trailing errors or identity conflicts invalidate earlier quotes.
      if (!settled && !buffer.trim() && replayCompleted && symbols.every((symbol) => output.get(symbol).quote)) finish(resolve, rejectPromise);
    });
  });
}
