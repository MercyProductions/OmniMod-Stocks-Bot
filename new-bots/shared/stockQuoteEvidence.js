// Alpaca announced SIP shares (not round lots) effective 2025-11-03.
// IEX size units are not resolved by that CTA/UTP notice: use the raw count
// as a conservative share lower bound, never multiply it by an assumed lot.
const SHARE_SIZE_FROM = Date.parse('2025-11-03T00:00:00Z');
const symbolValid = value => typeof value === 'string' && /^[A-Z][A-Z0-9.-]{0,9}$/.test(value);
const sizeBasis = feed => feed === 'sip' ? 'sip_shares_since_2025_11_03' : 'iex_reported_size_conservative_shares';
const fail = code => { throw Object.assign(new Error(code), { code }); };

// ETFs/ETPs use the same listed-equity quote schema. Ownership is checked
// separately by shared risk; class spelling cannot bypass native proof.
export const isStockQuoteInstrument = assetClass => ['stock', 'etf', 'etp'].includes(String(assetClass).toLowerCase());
export const requiredStockQuoteFeed = instrument => ['etf', 'etp'].includes(String(instrument?.assetClass).toLowerCase())
  ? 'sip' : instrument?.stockQuoteEvidence?.feed;

export function normalizeStockQuoteEvidence(value) {
  if (!value || value.version !== 1 || value.kind !== 'alpaca_stock_l1' || value.provider !== 'Alpaca'
    || !symbolValid(value.symbol) || !['iex', 'sip'].includes(value.feed) || value.currency !== 'USD'
    || !['latest', 'snapshot', 'stream'].includes(value.source)
    || value.coverage !== (value.feed === 'sip' ? 'consolidated' : 'single_venue')
    || typeof value.time !== 'string' || typeof value.rawTimestamp !== 'string'
    || !Number.isFinite(Date.parse(value.time)) || Date.parse(value.time) < SHARE_SIZE_FROM
    || Date.parse(value.time) !== Date.parse(value.rawTimestamp)
    || ![value.bid, value.ask].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0) || value.ask < value.bid
    || ![value.reportedBidSize, value.reportedAskSize].every(n => Number.isSafeInteger(n) && n > 0)
    || value.bidSizeShares !== value.reportedBidSize || value.askSizeShares !== value.reportedAskSize
    || value.sizeBasis !== sizeBasis(value.feed)
    || ![value.bidExchange, value.askExchange].every(s => typeof s === 'string' && /^[A-Z0-9]$/.test(s))
    || (value.feed === 'iex' && (value.bidExchange !== 'V' || value.askExchange !== 'V'))
    || !['A', 'B', 'C'].includes(value.tape)
    || !Array.isArray(value.conditions) || value.conditions.length < 1 || value.conditions.length > 8
    || value.conditions.some(s => typeof s !== 'string' || !/^[A-Z0-9 ]$/.test(s))) return null;
  return { version: 1, kind: value.kind, symbol: value.symbol, provider: 'Alpaca', feed: value.feed, coverage: value.coverage,
    currency: 'USD', source: value.source, time: value.time, rawTimestamp: value.rawTimestamp,
    bid: value.bid, ask: value.ask, reportedBidSize: value.reportedBidSize, reportedAskSize: value.reportedAskSize,
    bidSizeShares: value.bidSizeShares, askSizeShares: value.askSizeShares, sizeBasis: value.sizeBasis,
    bidExchange: value.bidExchange, askExchange: value.askExchange, tape: value.tape, conditions: [...value.conditions] };
}

export function stockQuoteEvidenceRejection(symbol, value, quote, expectedFeed) {
  const e = normalizeStockQuoteEvidence(value);
  if (!e) return 'stock_quote_evidence_required';
  if (e.symbol !== symbol || e.bid !== Number(quote?.bid) || e.ask !== Number(quote?.ask)
    || Date.parse(e.time) !== Date.parse(quote?.time)) return 'stock_quote_evidence_mismatch';
  if (expectedFeed != null && e.feed !== expectedFeed) return 'stock_quote_feed_mismatch';
  // Only the reviewed regular two-sided condition can model an executable
  // quote; other conditions remain research and receive an explicit reason.
  if (e.conditions.some(c => c !== 'R')) return 'stock_quote_condition_not_regular';
  return null;
}

export function parseAlpacaStockQuote(raw, { symbol, feed, source = 'latest', now = Date.now(), maxQuoteAgeMs = 15000 } = {}) {
  if (!Number.isFinite(now) || !Number.isFinite(maxQuoteAgeMs) || maxQuoteAgeMs <= 0) return fail('stock_quote_policy_invalid');
  if (raw?.S != null && raw.S !== symbol) return fail('stock_quote_symbol_mismatch');
  const at = typeof raw?.t === 'string' ? Date.parse(raw.t) : NaN;
  if (!Number.isFinite(at) || at > now + 5000 || now - at > maxQuoteAgeMs) return fail('stale_or_future_quote');
  const evidence = normalizeStockQuoteEvidence({ version: 1, kind: 'alpaca_stock_l1', symbol, provider: 'Alpaca', feed,
    coverage: feed === 'sip' ? 'consolidated' : 'single_venue', currency: 'USD', source,
    time: new Date(at).toISOString(), rawTimestamp: raw.t, bid: raw.bp, ask: raw.ap,
    reportedBidSize: raw.bs, reportedAskSize: raw.as, bidSizeShares: raw.bs, askSizeShares: raw.as,
    sizeBasis: sizeBasis(feed), bidExchange: raw.bx, askExchange: raw.ax, tape: raw.z, conditions: raw.c });
  const quote = { bid: raw.bp, ask: raw.ap, time: new Date(at).toISOString(), quality: 'executable' };
  const reason = stockQuoteEvidenceRejection(symbol, evidence, quote, feed);
  if (reason) return fail(reason);
  return { ...quote, provider: 'Alpaca', feed, coverage: evidence.coverage, stockQuoteEvidence: evidence };
}
