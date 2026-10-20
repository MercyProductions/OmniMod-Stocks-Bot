import { normalizeStockQuoteEvidence, stockQuoteEvidenceRejection } from '../../new-bots/shared/stockQuoteEvidence.js';

const nativeFailures = new Set(['stock_quote_condition_not_regular', 'stale_or_future_quote',
  'stock_quote_symbol_mismatch', 'stock_quote_evidence_required', 'stock_quote_policy_invalid']);

/** Only native evidence matching this asset can enter the shared paper ledger. */
export function buildStockPaperQuotes(assets, { feed, now = Date.now(), maxQuoteAgeMs = 15000 } = {}) {
  const quotes = new Map(), counts = new Map(), rejectionReasons = {}, rejections = [];
  const symbolOf = asset => String(asset?.symbol || '').toUpperCase();
  for (const asset of assets) counts.set(symbolOf(asset), (counts.get(symbolOf(asset)) || 0) + 1);
  const reject = (symbol, reason) => {
    rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
    rejections.push({ symbol, reason });
  };
  for (const asset of assets) {
    const symbol = symbolOf(asset), q = { bid: asset?.bidPrice, ask: asset?.askPrice, time: asset?.quoteUpdatedAt };
    const at = Date.parse(q.time);
    const reason = !['iex', 'sip'].includes(feed) || !Number.isFinite(now) || !Number.isFinite(maxQuoteAgeMs) || maxQuoteAgeMs <= 0
      ? 'stock_quote_policy_invalid' : counts.get(symbol) > 1 ? 'duplicate_stock_symbol'
      : asset?.halted ? 'stock_halted'
      : !asset?.stockQuoteEvidence && nativeFailures.has(asset?.stockQuoteRejection) ? asset.stockQuoteRejection
      : stockQuoteEvidenceRejection(symbol, asset?.stockQuoteEvidence, q, feed)
        || (!Number.isFinite(at) || at > now + 5000 || now - at > maxQuoteAgeMs ? 'stale_or_future_quote' : null);
    if (reason) { reject(symbol, reason); continue; }
    const evidence = normalizeStockQuoteEvidence(asset.stockQuoteEvidence);
    quotes.set(symbol, { ...q, quality: 'executable', provider: 'Alpaca', feed, coverage: evidence.coverage, stockQuoteEvidence: evidence });
  }
  return { quotes, diagnostics: { evaluated: assets.length, executableQuotes: quotes.size, rejected: rejections.length,
    feed, rejectionReasons, rejections } };
}
