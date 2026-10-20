import { createHash } from 'node:crypto';
import net from 'node:net';
import { parseFuturesExpiry } from './universe.js';
import { createLiveSymbolRouter, liveNumber, parseLiveQuote as parseQuote } from './databentoLiveProtocol.js';
import { validateFuturesSession } from './dayStrategy.js';

const LIVE_PORT = 13_000;

/** Capture one verified current Databento MBP-1 top-of-book update per active futures contract.
 * This is a read-only monitor for existing paper positions; it creates no entries or broker orders.
 */
export async function fetchDatabentoFuturePositionMarks(orders, {
  apiKey = '', dataset = 'GLBX.MDP3', now = Date.now(), maxQuoteAgeMs = 5_000,
  maxTransportLagMs = 2_000, timeoutMs = 8_000, metrics = [], clock = Date.now, connect = (options) => net.connect(options),
} = {}) {
  if (!Array.isArray(orders)) throw new TypeError('Open Futures paper orders must be an array.');
  if (!Array.isArray(metrics)) throw new TypeError('Provider metrics must be an array.');
  const positions = orders.filter((order) => order?.owner === 'futures' && order.assetClass === 'future'
    && ['reserved', 'filled', 'open'].includes(order.status));
  if (!positions.length) return { marks: [], diagnostics: { status: 'no_open_futures_positions', positions: 0, quoted: 0, rejected: 0 } };
  if (!apiKey) return { marks: [], diagnostics: { status: 'credentials_missing', positions: positions.length, quoted: 0, rejected: positions.length } };
  if (!/^[A-Z0-9.]{3,24}$/.test(dataset)) throw new TypeError('Invalid Databento dataset identifier.');
  if (![maxQuoteAgeMs, maxTransportLagMs, timeoutMs].every((value) => Number.isFinite(value) && value > 0)) throw new RangeError('Databento live quote limits must be positive.');
  if (!Number.isFinite(now)) throw new TypeError('Provider mark time must be finite.');

  const validRawSymbol = (value) => /^[A-Z0-9]{2,16}$/.test(String(value ?? '').trim().toUpperCase());
  const specByOrder = new Map();
  const rejectionReasons = {};
  const reject = (reason) => { rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1; };
  for (const order of positions) {
    const rawSymbol = String(order.future?.providerRawSymbol ?? '').trim().toUpperCase();
    const contractId = String(order.future?.contractId ?? '').trim().toUpperCase();
    const verifiedAtText = String(order.future?.specVerifiedAt ?? '').trim();
    const verifiedAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(verifiedAtText)
      ? Date.parse(verifiedAtText) : NaN;
    const expiryAt = parseFuturesExpiry(order.future?.expiryAt ?? order.future?.expiry);
    const source = String(order.future?.specSource ?? '').trim();
    let sourceIsVerifiedHttps = false;
    try { const url = new URL(source); sourceIsVerifiedHttps = url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password; } catch { /* invalid citation */ }
    const reasons = [];
    if (order.future?.providerDataset != null && order.future.providerDataset !== dataset) reasons.push('position_dataset_mismatch');
    if (order.future?.providerPublisherId != null && (!Number.isInteger(liveNumber(order.future.providerPublisherId))
      || liveNumber(order.future.providerPublisherId) < 1 || liveNumber(order.future.providerPublisherId) > 65535)) reasons.push('position_publisher_invalid');
    if (!validRawSymbol(rawSymbol)) reasons.push('position_raw_symbol_invalid');
    if (!contractId || contractId !== String(order.instrumentKey ?? '').toUpperCase()) reasons.push('position_contract_id_mismatch');
    if (order.future?.activeContract !== true || order.future?.contractSpecVerified !== true) reasons.push('position_contract_not_verified_active');
    if (!sourceIsVerifiedHttps) reasons.push('position_contract_source_not_verified_https');
    if (!(Number.isFinite(liveNumber(order.future?.tickSize)) && liveNumber(order.future.tickSize) > 0)) reasons.push('position_tick_size_invalid');
    if (!(Number.isFinite(liveNumber(order.multiplier)) && liveNumber(order.multiplier) > 0)
      || liveNumber(order.future?.multiplier) !== liveNumber(order.multiplier)) reasons.push('position_multiplier_mismatch');
    if (!Number.isSafeInteger(liveNumber(order.units)) || liveNumber(order.units) <= 0) reasons.push('position_units_invalid');
    if (!Number.isFinite(verifiedAt) || verifiedAt > now || now - verifiedAt > 90 * 86_400_000) reasons.push('position_contract_verification_time_invalid_or_stale');
    if (!Number.isFinite(expiryAt) || expiryAt <= now) reasons.push('position_contract_expiry_invalid_or_passed');
    if (reasons.length) {
      for (const reason of reasons) reject(reason);
      continue;
    }
    specByOrder.set(order.orderId, rawSymbol);
  }
  const reviewedPublishers = new Map();
  for (const order of positions.filter((o) => specByOrder.has(o.orderId) && o.future.providerPublisherId != null)) {
    const symbol = specByOrder.get(order.orderId), set = reviewedPublishers.get(symbol) || new Set();
    set.add(liveNumber(order.future.providerPublisherId)); reviewedPublishers.set(symbol, set);
  }
  for (const order of positions) if (reviewedPublishers.get(specByOrder.get(order.orderId))?.size > 1) {
    specByOrder.delete(order.orderId); reject('position_publisher_conflict');
  }
  const symbols = [...new Set(specByOrder.values())];
  if (!symbols.length) return { marks: [], diagnostics: { status: 'contract_metadata_unavailable', positions: positions.length, quoted: 0,
    rejected: positions.length, rejectionReasons, providerRequests: 0 } };
  if (symbols.length > 100) return { marks: [], diagnostics: { status: 'position_symbol_cap_exceeded', positions: positions.length, symbols: symbols.length,
    quoted: 0, rejected: positions.length, rejectionReasons: { position_symbol_cap_exceeded: positions.length }, providerRequests: 0 } };

  const startedAt = Date.now();
  const host = `${dataset.toLowerCase().replaceAll('.', '-')}.lsg.databento.com`;
  const quotes = new Map();
  const router = createLiveSymbolRouter(symbols, { expectedPublishers: new Map(positions.filter((order) => specByOrder.has(order.orderId) && order.future.providerPublisherId != null)
    .map((order) => [specByOrder.get(order.orderId), liveNumber(order.future.providerPublisherId)])) });
  const clockStart = clock(), observedNow = () => now + Math.max(0, clock() - clockStart);
  let socket;
  let buffer = '';
  let phase = 'greeting';
  let records = 0;
  let settled = false;
  let timer;
  let bytes = 0;
  const finish = (resolve, rejectPromise, error = null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket?.destroy();
    const latencyMs = Math.max(0, Date.now() - startedAt);
    const finalNow = observedNow();
    const quotedSymbols = [...quotes].filter(([symbol, record]) => !router.reasonsFor(symbol).length && parseQuote(record, finalNow, maxQuoteAgeMs, maxTransportLagMs)).length;
    metrics.push({ provider: 'Databento Live', operation: 'mbp-1-position-quotes', status: error ? 0 : quotedSymbols === symbols.length ? 200 : 408,
      latencyMs, records, requestedSymbols: symbols.length, quotedSymbols, ...(error ? { error: String(error.message || error).slice(0, 180) } : {}) });
    if (error) { rejectPromise(error); return; }
    const marks = [];
    const requiredBySymbol = new Map();
    for (const order of positions) {
      const rawSymbol = specByOrder.get(order.orderId);
      if (rawSymbol) requiredBySymbol.set(rawSymbol, (requiredBySymbol.get(rawSymbol) ?? 0) + Number(order.units));
    }
    for (const order of positions) {
      const rawSymbol = specByOrder.get(order.orderId);
      const record = rawSymbol ? quotes.get(rawSymbol) : null;
      const quote = record ? parseQuote(record, finalNow, maxQuoteAgeMs, maxTransportLagMs) : null;
      if (!rawSymbol) continue;
      const protocolReasons = router.reasonsFor(rawSymbol);
      if (protocolReasons.length) { protocolReasons.forEach(reject); continue; }
      if (parseFuturesExpiry(order.future?.expiryAt ?? order.future?.expiry) <= finalNow
        || finalNow - Date.parse(order.future.specVerifiedAt) > 90 * 86_400_000) { reject('position_contract_became_invalid_during_collection'); continue; }
      if (!quote) { reject('current_executable_quote_unavailable'); continue; }
      const requiredSize = requiredBySymbol.get(rawSymbol);
      const tickSize = Number(order.future?.tickSize);
      const tickAligned = (value) => Math.abs(value / tickSize - Math.round(value / tickSize)) <= 1e-6;
      if (!(Number.isFinite(requiredSize) && requiredSize > 0 && quote.bidSize >= requiredSize && quote.askSize >= requiredSize)) {
        reject('top_of_book_size_below_position');
        continue;
      }
      if (!(tickAligned(quote.bid) && tickAligned(quote.ask))) { reject('quote_off_verified_contract_tick'); continue; }
      const session = validateFuturesSession(order.future.entrySession ?? {}, { now: finalNow });
      const quoteAt = Date.parse(quote.time);
      const sessionOpen = session.valid && session.marketDate === order.sessionDate
        && finalNow >= session.openTime && finalNow < session.closeTime
        && quoteAt >= session.openTime && quoteAt < session.closeTime;
      marks.push({ orderId: order.orderId, quote: { bid: quote.bid, ask: quote.ask, time: quote.time, quality: 'executable' }, sessionOpen });
    }
    resolve({ marks, diagnostics: { status: error ? 'partial_or_failed' : marks.length === positions.length ? 'complete' : 'partial',
      positions: positions.length, symbols: symbols.length, quoted: marks.length, rejected: positions.length - marks.length,
      rejectionReasons, providerRequests: 1, providerRecords: records, latencyMs: Math.max(0, Date.now() - startedAt), dataset,
      protocol: router.diagnostics(), evaluatedAt: new Date(finalNow).toISOString() } });
  };

  return await new Promise((resolve, rejectPromise) => {
    timer = setTimeout(() => finish(resolve, rejectPromise, new Error('Databento live position quote timeout.')), timeoutMs);
    try {
      socket = connect({ host, port: LIVE_PORT });
    } catch (error) {
      finish(resolve, rejectPromise, error);
      return;
    }
    socket.setTimeout?.(timeoutMs, () => finish(resolve, rejectPromise, new Error('Databento live position quote timeout.')));
    socket.on('connect', () => {});
    socket.on('error', (error) => finish(resolve, rejectPromise, error));
    socket.on('close', () => {
      if (!settled) finish(resolve, rejectPromise, new Error('Databento live socket closed before a quote was received.'));
    });
    socket.on('data', (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > 32 * 1024 * 1024) { finish(resolve, rejectPromise, new Error('Databento live mark byte limit exceeded.')); return; }
      buffer += chunk.toString('utf8');
      if (buffer.length > 8 * 1024 * 1024) { finish(resolve, rejectPromise, new Error('Databento live message buffer exceeded its safety limit.')); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0 && !settled) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (phase !== 'stream') {
          const fields = Object.fromEntries(line.split('|').map((field) => {
            const index = field.indexOf('=');
            return index < 0 ? [field, ''] : [field.slice(0, index), field.slice(index + 1)];
          }));
          if (fields.cram) {
            const response = createHash('sha256').update(`${fields.cram}|${apiKey}`).digest('hex');
            const bucket = Buffer.from(apiKey, 'utf8').subarray(-5).toString('utf8');
            socket.write(`auth=${response}-${bucket}|dataset=${dataset}|encoding=json|compression=none|ts_out=1|pretty_px=1|pretty_ts=1|heartbeat_interval_s=10|slow_reader_behavior=warn\n`);
            phase = 'auth-response';
          } else if (fields.success === '1' && phase === 'auth-response') {
            socket.write(`schema=mbp-1|stype_in=raw_symbol|symbols=${symbols.join(',')}|id=1\n`);
            socket.write('start_session=0\n');
            phase = 'stream';
          } else if (fields.success === '0' || fields.error) {
            finish(resolve, rejectPromise, new Error('Databento live gateway rejected authentication.'));
          }
          continue;
        }
        let record;
        try { record = JSON.parse(line); }
        catch { finish(resolve, rejectPromise, new Error('Databento live stream returned malformed JSON.')); continue; }
        records += 1;
        if (records > 100_000) { finish(resolve, rejectPromise, new Error('Databento live mark record limit exceeded.')); continue; }
        let routed;
        try { routed = router.route(record); } catch (error) { finish(resolve, rejectPromise, error); continue; }
        if (routed.kind !== 'quote') continue;
        const quote = parseQuote(routed.record, observedNow(), maxQuoteAgeMs, maxTransportLagMs);
        if (quote) quotes.set(routed.symbol, routed.record); else quotes.delete(routed.symbol);
      }
      if (!settled && !buffer.trim() && symbols.every((symbol) => quotes.has(symbol))) finish(resolve, rejectPromise);
    });
  });
}
