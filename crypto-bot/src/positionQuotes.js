import { join } from 'node:path';
import { dataDir } from './config.js';
import { fetchCryptoInstrumentRules, fetchCoinbasePaperBook, refreshCryptoPaperIdentity } from './marketProviders.js';
import { loadPaperPositionIdentity } from './paperIdentityCache.js';
import { collectKrakenPositionQuotes } from './krakenPositionQuotes.js';
import { parseKrakenPaperBook } from './krakenPaperBook.js';
import { buildCryptoPaperQuotes } from './paperExecutionQuotes.js';
import { withProviderTelemetry } from './providerTelemetry.js';
import { normalizeCryptoExecutionIdentity, cryptoExecutionIdentityKey } from '../../new-bots/shared/cryptoExecutionIdentity.js';
import { cryptoInstrumentRulesRejection } from '../../new-bots/shared/cryptoInstrumentRules.js';

const safeCode = (error, fallback) => /^[a-z_]{1,80}$/.test(error?.code ?? '') ? error.code : fallback;
export async function fetchCryptoPositionQuotes(orders, { env = process.env, clock = Date.now,
  identityDirectory = join(env.OMNIMOD_CRYPTO_DATA_DIR || dataDir, 'paper-position-identities'),
  refreshIdentity = id => refreshCryptoPaperIdentity(id, { coingeckoApiKey: env.COINGECKO_API_KEY || '', coingeckoApiTier: env.COINGECKO_API_TIER || 'public' }),
  loadRules = fetchCryptoInstrumentRules, loadCoinbaseBook = fetchCoinbasePaperBook, collectKraken = collectKrakenPositionQuotes } = {}) {
  const started = clock(), maxQuoteAgeMs = Number(env.SHARED_MAX_QUOTE_AGE_MS || 15000);
  if (!Number.isFinite(maxQuoteAgeMs) || maxQuoteAgeMs <= 0) throw new TypeError('Invalid Crypto monitor quote age.');
  const positions = orders.filter(o => o.owner === 'crypto' && o.assetClass === 'crypto' && ['reserved', 'filled', 'open'].includes(o.status));
  const reasons = {}, reject = code => { reasons[code] = (reasons[code] || 0) + 1; };
  const routes = new Map(), claims = new Map(), invalid = new Map();
  for (const order of positions) {
    const id = normalizeCryptoExecutionIdentity(order.cryptoIdentity), key = cryptoExecutionIdentityKey(id);
    if (!id) { invalid.set(order.orderId, 'legacy_crypto_execution_identity_unavailable'); continue; }
    const native = `${id.provider}:${id.pair}`, keys = claims.get(native) || new Set(); keys.add(key); claims.set(native, keys);
    if (!routes.has(key) || Date.parse(routes.get(key).verifiedAt) < Date.parse(id.verifiedAt)) routes.set(key, id);
  }
  const failed = new Map(), ready = new Map(), nativeQuotes = new Map(), krakenSizes = new Map();
  let kraken = { diagnostics: { status: 'not_needed', sessions: 0, durationMs: 0 } };
  const measured = await withProviderTelemetry(async () => {
    const entries = [...routes].sort(([a], [b]) => a.localeCompare(b));
    // Rotate only expensive identity refresh priority; all persisted positions remain eligible.
    const offset = entries.length ? Math.floor(started / 60000) % entries.length : 0;
    for (const [key, id] of [...entries.slice(offset), ...entries.slice(0, offset)]) {
      if (claims.get(`${id.provider}:${id.pair}`).size !== 1) { failed.set(key, 'conflicting_asset_ids_for_native_pair'); continue; }
      try {
        ready.set(key, await loadPaperPositionIdentity(id, { directory: identityDirectory, refresh: refreshIdentity, clock,
          allowRefresh: clock() - started < 90000 }));
      } catch (error) { failed.set(key, safeCode(error, 'crypto_identity_refresh_unavailable')); }
    }
    const withRules = new Map(); let cursor = 0; const jobs = [...ready];
    await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => {
      while (cursor < jobs.length) {
        const [key, id] = jobs[cursor++];
        try {
          const rules = await loadRules(id, { clock }), code = cryptoInstrumentRulesRejection(rules, id, clock());
          if (code) throw Object.assign(new Error(code), { code });
          withRules.set(key, { id, rules });
        } catch (error) { failed.set(key, safeCode(error, 'crypto_product_metadata_unavailable')); }
      }
    }));
    const krakenRoutes = [...withRules].filter(([, row]) => row.id.provider === 'Kraken');
    const symbolKeys = new Map();
    for (const [key, { id }] of krakenRoutes) {
      const symbol = `${id.base}/${id.quoteCurrency}`, keys = symbolKeys.get(symbol) || []; keys.push(key); symbolKeys.set(symbol, keys);
    }
    for (const keys of symbolKeys.values()) if (keys.length !== 1) for (const key of keys) failed.set(key, 'ambiguous_kraken_stream_route');
    const symbols = [...symbolKeys].filter(([, keys]) => keys.length === 1).map(([symbol]) => symbol);
    const coinbase = [...withRules].filter(([, row]) => row.id.provider === 'Coinbase'); cursor = 0;
    await Promise.all([
      ...Array.from({ length: Math.min(3, coinbase.length) }, async () => {
        while (cursor < coinbase.length) {
          const [key, { id, rules }] = coinbase[cursor++];
          try {
            const q = await loadCoinbaseBook(id, { maxQuoteAgeMs, clock });
            if (cryptoExecutionIdentityKey(q?.cryptoIdentity) !== key) throw new Error('Wrong native quote identity.');
            nativeQuotes.set(key, { ...q, cryptoInstrumentRules: rules });
          } catch (error) { failed.set(key, safeCode(error, 'coinbase_paper_book_unavailable')); }
        }
      }),
      (async () => {
        if (!symbols.length) return;
        try { kraken = await collectKraken(symbols, { clock, maxQuoteAgeMs }); }
        catch { kraken = { quotes: new Map(), diagnostics: { status: 'collector_failed', sessions: 1, durationMs: 0 } }; }
        for (const symbol of symbols) {
          const key = symbolKeys.get(symbol)[0], { id, rules } = withRules.get(key), q = kraken.quotes?.get(symbol);
          if (!q || q.symbol !== symbol || ![q.bidSize, q.askSize].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0)) {
            failed.set(key, 'kraken_timestamped_bbo_unavailable'); continue;
          }
          try {
            const native = parseKrakenPaperBook(q, id, { now: clock(), maxQuoteAgeMs });
            krakenSizes.set(key, native.cryptoQuoteEvidence);
            nativeQuotes.set(key, { ...native, cryptoInstrumentRules: rules });
          } catch (error) { failed.set(key, safeCode(error, 'kraken_timestamped_bbo_unavailable')); }
        }
      })(),
    ]);
  });
  const assets = new Map();
  for (const [key, quote] of nativeQuotes) {
    const id = ready.get(key), asset = assets.get(id.assetId) || { id: id.assetId, symbol: id.base, marketData: { quotes: [] } };
    asset.marketData.quotes.push(quote); assets.set(id.assetId, asset);
  }
  const built = buildCryptoPaperQuotes([...assets.values()], { now: clock(), maxQuoteAgeMs });
  for (const row of built.rejections) for (const [key, id] of ready) if (id.assetId === row.assetId && id.provider === row.provider && id.pair === row.pair) failed.set(key, row.code);
  const marks = [];
  for (const order of positions) {
    const key = cryptoExecutionIdentityKey(order.cryptoIdentity), quote = built.quotesByKey.get(key);
    const code = invalid.get(order.orderId) || failed.get(key);
    if (code || !quote) { reject(code || 'crypto_position_quote_missing'); continue; }
    const book = krakenSizes.get(key);
    if (book) {
      const side = (order.status === 'reserved') === (order.direction === 'long') ? 'askSize' : 'bidSize';
      if (!['long', 'short'].includes(order.direction) || typeof order.units !== 'number' || !Number.isFinite(order.units) || order.units <= 0 || order.units > book[side]) {
        reject('insufficient_displayed_kraken_liquidity'); continue;
      }
    }
    marks.push({ orderId: order.orderId, quote, sessionOpen: true });
  }
  const providerRows = Object.values(measured.providers);
  const http = providerRows.reduce((n, row) => n + row.requests, 0), failures = providerRows.reduce((n, row) => n + row.failures, 0);
  const sessions = Number(kraken.diagnostics.sessions) || 0;
  return { marks, requestSummary: { attempts: http + sessions, failures: failures + (sessions && kraken.diagnostics.status !== 'complete' ? 1 : 0),
    latencyMs: providerRows.reduce((n, row) => n + row.totalLatencyMs, 0) + (Number(kraken.diagnostics.durationMs) || 0), httpAttempts: http, websocketSessions: sessions },
    diagnostics: { status: marks.length === positions.length ? 'complete' : 'partial', positions: positions.length, exactRoutes: routes.size,
      identityReady: ready.size, quotesReady: built.quotesByKey.size, rejectionReasons: reasons, krakenStatus: kraken.diagnostics.status,
      identityBudgetMs: 90000, durationMs: Math.max(0, clock() - started) } };
}
