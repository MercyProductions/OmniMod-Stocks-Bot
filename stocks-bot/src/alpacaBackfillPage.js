import { createHash } from 'node:crypto';

/** Validate a provider page before it can be persisted as part of a research dataset. */
export function normalizeAlpacaBackfillPage(payload, { symbols, start, end, lastTimestampBySymbol = {} } = {}) {
  const requested = new Set((Array.isArray(symbols) ? symbols : []).map((symbol) => String(symbol).trim().toUpperCase()));
  const startMs = Date.parse(start), endMs = Date.parse(end);
  if (!requested.size || [...requested].some((symbol) => !/^[A-Z][A-Z0-9.-]{0,10}$/.test(symbol))) {
    throw new TypeError('Alpaca backfill symbols must contain at least one valid requested symbol.');
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new RangeError('Alpaca backfill range must have a valid start before end.');
  }
  if (!lastTimestampBySymbol || typeof lastTimestampBySymbol !== 'object' || Array.isArray(lastTimestampBySymbol)
    || Object.entries(lastTimestampBySymbol).some(([symbol, value]) => !requested.has(symbol)
      || !Number.isSafeInteger(value) || value < 0)) throw new TypeError('Alpaca backfill page cursor state is malformed.');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !payload.bars || typeof payload.bars !== 'object' || Array.isArray(payload.bars)) {
    throw new TypeError('Alpaca bars response is malformed.');
  }
  if (payload.next_page_token != null && typeof payload.next_page_token !== 'string') {
    throw new TypeError('Alpaca pagination token is malformed.');
  }

  const rows = [];
  const seen = new Set();
  const lastBySymbol = { ...lastTimestampBySymbol };
  for (const [rawSymbol, bars] of Object.entries(payload.bars)) {
    const symbol = rawSymbol.trim().toUpperCase();
    if (!requested.has(symbol)) throw new Error(`Alpaca returned an unrequested symbol: ${symbol || 'unknown'}.`);
    if (!Array.isArray(bars)) throw new TypeError(`Alpaca bars for ${symbol} are malformed.`);
    let lastTimestamp = Number.isSafeInteger(lastBySymbol[symbol]) ? lastBySymbol[symbol] : null;
    for (const bar of bars) {
      if (!bar || typeof bar !== 'object' || Array.isArray(bar)) throw new TypeError(`Alpaca returned a malformed ${symbol} bar.`);
      const timeMs = Date.parse(bar.t);
      const values = [bar.o, bar.h, bar.l, bar.c].map(Number);
      const volume = Number(bar.v);
      const tradeCount = bar.n == null ? 0 : Number(bar.n);
      const vwap = bar.vw == null ? 0 : Number(bar.vw);
      if (!Number.isFinite(timeMs) || timeMs < startMs || timeMs >= endMs
        || values.some((value) => !Number.isFinite(value) || value <= 0)
        || values[1] < Math.max(values[0], values[2], values[3])
        || values[2] > Math.min(values[0], values[1], values[3])
        || !Number.isFinite(volume) || volume < 0
        || !Number.isFinite(tradeCount) || tradeCount < 0
        || !Number.isFinite(vwap) || vwap < 0) {
        throw new Error(`Alpaca returned an invalid or out-of-range ${symbol} bar.`);
      }
      const timestamp = Math.floor(timeMs / 1000);
      const key = `${symbol}:${timestamp}`;
      if (seen.has(key)) throw new Error(`Alpaca returned a duplicate ${symbol} bar timestamp.`);
      if (lastTimestamp !== null && timestamp <= lastTimestamp) throw new Error(`Alpaca returned duplicate or out-of-order ${symbol} bars across pages.`);
      seen.add(key);
      lastTimestamp = timestamp;
      rows.push({ symbol, timestamp, open: values[0], high: values[1], low: values[2], close: values[3], volume, tradeCount, vwap });
    }
    if (lastTimestamp !== null) lastBySymbol[symbol] = lastTimestamp;
  }
  return { rows, nextPageToken: payload.next_page_token || '', lastTimestampBySymbol: lastBySymbol };
}

export function hashAlpacaPageToken(token) {
  if (typeof token !== 'string' || !token) return '';
  // Pagination cursors are opaque; store only a stable digest in checkpoints.
  return createHash('sha256').update(token).digest('hex');
}

export function inspectAlpacaBackfillCheckpoint(checkpoint, { signature, symbols } = {}) {
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
    throw new TypeError('Historical backfill checkpoint is malformed; it was preserved and no data was changed.');
  }
  if (![1, 2].includes(checkpoint.version) || !Number.isSafeInteger(checkpoint.pages) || checkpoint.pages < 0
    || !Number.isSafeInteger(checkpoint.bars) || checkpoint.bars < 0
    || typeof checkpoint.nextPageToken !== 'string' || typeof checkpoint.completed !== 'boolean') {
    throw new TypeError('Historical backfill checkpoint is malformed; it was preserved and no data was changed.');
  }
  const expectedSignature = typeof signature === 'string' ? signature : JSON.stringify(signature);
  if (checkpoint.pages > 0 && checkpoint.signature !== expectedSignature && JSON.stringify(checkpoint.signature) !== expectedSignature) {
    throw new Error('Historical backfill checkpoint does not match the requested symbols, range, feed, and timeframe.');
  }
  const tokenHashes = checkpoint.seenPageTokenHashes ?? [];
  if (!Array.isArray(tokenHashes) || tokenHashes.some((hash) => typeof hash !== 'string' || !/^[a-f\d]{64}$/i.test(hash))) {
    throw new TypeError('Historical backfill checkpoint is malformed; it was preserved and no data was changed.');
  }

  const legacyPriorCoverageUnknown = checkpoint.priorCoverageStatus === 'unknown_legacy_checkpoint'
    || (checkpoint.version === 1 && checkpoint.pages > 0);
  let lastTimestampBySymbol = {}, coverageBySymbol = Object.fromEntries(symbols.map((symbol) => [symbol,
    { bars: 0, firstTimestamp: null, lastTimestamp: null }]));
  if (checkpoint.version === 2) {
    const validTimestamp = (value) => value === null || (Number.isSafeInteger(value) && value >= 0);
    const requested = new Set(symbols);
    const cursors = checkpoint.lastTimestampBySymbol, coverage = checkpoint.coverageBySymbol;
    if (!cursors || typeof cursors !== 'object' || Array.isArray(cursors) || !coverage || typeof coverage !== 'object' || Array.isArray(coverage)
      || Object.entries(cursors).some(([symbol, value]) => !requested.has(symbol) || !Number.isSafeInteger(value) || value < 0)
      || JSON.stringify(Object.keys(coverage).sort()) !== JSON.stringify([...symbols].sort())) {
      throw new TypeError('Historical backfill checkpoint is malformed; it was preserved and no data was changed.');
    }
    for (const [symbol, row] of Object.entries(coverage)) {
      const validEmpty = row?.bars === 0 && row.firstTimestamp === null && row.lastTimestamp === null && cursors[symbol] === undefined;
      const validObserved = Number.isSafeInteger(row?.bars) && row.bars > 0 && Number.isSafeInteger(row.firstTimestamp)
        && row.firstTimestamp >= 0 && Number.isSafeInteger(row.lastTimestamp) && row.lastTimestamp >= row.firstTimestamp
        && cursors[symbol] === row.lastTimestamp;
      const validLegacyUnknown = legacyPriorCoverageUnknown && row?.bars === null
        && row.firstTimestamp === null && row.lastTimestamp === null;
      if (!row || !validTimestamp(row.firstTimestamp) || !validTimestamp(row.lastTimestamp)
        || !(validEmpty || validObserved || validLegacyUnknown)) {
        throw new TypeError('Historical backfill checkpoint is malformed; it was preserved and no data was changed.');
      }
    }
    if (!legacyPriorCoverageUnknown && Object.values(coverage).reduce((sum, row) => sum + row.bars, 0) !== checkpoint.bars) {
      throw new TypeError('Historical backfill checkpoint bar totals do not match its per-symbol coverage.');
    }
    lastTimestampBySymbol = cursors;
    coverageBySymbol = coverage;
  } else if (legacyPriorCoverageUnknown) {
    coverageBySymbol = Object.fromEntries(symbols.map((symbol) => [symbol,
      { bars: 0, firstTimestamp: null, lastTimestamp: null }]));
  }
  return { legacyPriorCoverageUnknown, lastTimestampBySymbol, coverageBySymbol, seenPageTokenHashes: tokenHashes };
}

