import { buildCryptoPaperQuotes } from './paperExecutionQuotes.js';
import { fetchCoinbasePaperBook, fetchCryptoInstrumentRules } from './marketProviders.js';
import { collectKrakenPositionQuotes } from './krakenPositionQuotes.js';
import { parseKrakenPaperBook } from './krakenPaperBook.js';
import { cryptoExecutionIdentityKey, cryptoIdentityRejection, normalizeCryptoExecutionIdentity } from '../../new-bots/shared/cryptoExecutionIdentity.js';
import { cryptoInstrumentRulesRejection } from '../../new-bots/shared/cryptoInstrumentRules.js';

/** Refresh only verified USD routes already obtained by bounded deep analysis.
 * No discovery, historical downloads, new identities or currency assumptions.
 */
export async function refreshCryptoPaperQuotes(assets, {
  clock = Date.now, maxQuoteAgeMs = 15000, loadCoinbaseBook = fetchCoinbasePaperBook, loadInstrumentRules = fetchCryptoInstrumentRules,
  collectKraken = collectKrakenPositionQuotes,
} = {}) {
  const startedAt = clock();
  if (!Array.isArray(assets) || !Number.isFinite(startedAt) || !Number.isFinite(maxQuoteAgeMs) || maxQuoteAgeMs <= 0)
    throw new TypeError('Invalid Crypto paper refresh inputs.');
  const routes = new Map(), claims = new Map(), counts = new Map();
  for (const asset of assets) counts.set(asset?.id, (counts.get(asset?.id) || 0) + 1);
  for (const asset of assets) for (const quote of asset?.marketData?.quotes ?? []) {
    const id = normalizeCryptoExecutionIdentity(quote.cryptoIdentity);
    if (!id || !['Coinbase', 'Kraken'].includes(id.provider) || id.assetId !== asset.id) continue;
    const nativeKey = `${id.provider}:${id.pair}`;
    const claimed = claims.get(nativeKey) ?? new Set(); claimed.add(id.assetId); claims.set(nativeKey, claimed);
    if (counts.get(asset.id) !== 1 || cryptoIdentityRejection(id, startedAt)
      || quote.provider !== id.provider || quote.pair !== id.pair || quote.base !== id.base || quote.target !== id.quoteCurrency) continue;
    const key = cryptoExecutionIdentityKey(id), route = routes.get(key);
    if (route) route.count++;
    else routes.set(key, { id, asset, quote, count: 1 });
  }
  const jobs = [...routes.entries()].filter(([, row]) => row.count === 1 && claims.get(`${row.id.provider}:${row.id.pair}`)?.size === 1);
  const refreshed = new Map(), failures = [], failedKeys = new Set(), prepared = new Map();
  const reject = (key, row, stage, error, fallback) => {
    failedKeys.add(key);
    failures.push({ assetId: row.asset.id, symbol: row.asset.symbol, provider: row.id.provider, pair: row.id.pair,
      stage, code: /^[a-z_]{1,80}$/.test(error?.code ?? '') ? error.code : fallback });
  };
  let next = 0, receivedBooks = 0, receivedKrakenBooks = 0;
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => {
    while (next < jobs.length) {
      const [key, row] = jobs[next++], { id } = row;
      try {
        const rules = await loadInstrumentRules(id, { clock });
        const reason = cryptoInstrumentRulesRejection(rules, id, clock());
        if (reason) { const error = new Error(reason); error.code = reason; throw error; }
        prepared.set(key, { ...row, rules });
      } catch (error) { reject(key, row, 'shared_product_rules', error, 'crypto_product_metadata_unavailable'); }
    }
  }));
  const coinbase = [...prepared].filter(([, row]) => row.id.provider === 'Coinbase'), streamRoutes = new Map();
  for (const [key, row] of prepared) if (row.id.provider === 'Kraken') {
    const symbol = `${row.id.base}/${row.id.quoteCurrency}`, entries = streamRoutes.get(symbol) || [];
    entries.push([key, row]); streamRoutes.set(symbol, entries);
  }
  for (const [symbol, entries] of streamRoutes) if (entries.length !== 1) {
    for (const [key, row] of entries) reject(key, row, 'shared_quote_refresh', null, 'ambiguous_kraken_stream_route');
    streamRoutes.delete(symbol);
  }
  next = 0;
  let kraken = { status: 'not_needed', sessions: 0, durationMs: 0 };
  await Promise.all([
    ...Array.from({ length: Math.min(3, coinbase.length) }, async () => {
      while (next < coinbase.length) {
        const [key, row] = coinbase[next++];
        try {
          const quote = await loadCoinbaseBook(row.id, { maxQuoteAgeMs, clock });
          if (cryptoExecutionIdentityKey(quote?.cryptoIdentity) !== key) throw new Error('coinbase_book_returned_identity_mismatch');
          receivedBooks++; refreshed.set(key, { ...quote, cryptoInstrumentRules: row.rules });
        } catch (error) { reject(key, row, 'shared_quote_refresh', error, 'coinbase_paper_book_unavailable'); }
      }
    }),
    (async () => {
      if (!streamRoutes.size) return;
      let result;
      try { result = await collectKraken([...streamRoutes.keys()], { clock, maxQuoteAgeMs }); kraken = result.diagnostics; }
      catch { result = { quotes: new Map() }; kraken = { status: 'collector_failed', sessions: 1, durationMs: 0 }; }
      for (const [symbol, [[key, row]]] of streamRoutes) {
        try {
          const quote = parseKrakenPaperBook(result.quotes?.get(symbol), row.id, { now: clock(), maxQuoteAgeMs });
          receivedKrakenBooks++; refreshed.set(key, { ...quote, cryptoInstrumentRules: row.rules });
        } catch (error) { reject(key, row, 'shared_quote_refresh', error, 'kraken_timestamped_bbo_unavailable'); }
      }
    })(),
  ]);
  const rows = assets.map(asset => ({ ...asset, marketData: { ...asset.marketData, quotes:
    (asset.marketData?.quotes ?? []).map(quote => {
      const key = cryptoExecutionIdentityKey(quote.cryptoIdentity);
      return failedKeys.has(key) ? { ...quote, cryptoInstrumentRules: null, cryptoQuoteEvidence: null } : refreshed.get(key) ?? quote;
    }) } }));
  // Collection may outlast the freshness policy. Check every row again now,
  // including fresh Kraken stream observations. Failed books never fall back
  // to accepting a ticker as executable evidence.
  const result = buildCryptoPaperQuotes(rows, { now: clock(), maxQuoteAgeMs });
  result.rejections.push(...failures);
  for (const row of failures) result.diagnostics.rejectionCounts[row.code] = (result.diagnostics.rejectionCounts[row.code] || 0) + 1;
  result.diagnostics.refresh = { version: 3, source: 'native_product_rules_coinbase_l1_and_kraken_bbo', requestedRoutes: jobs.length,
    rulesReady: prepared.size, receivedBooks, receivedKrakenBooks, kraken, failures: failures.length, durationMs: Math.max(0, clock() - startedAt),
    concurrentRequests: Math.min(3, jobs.length) };
  return result;
}
