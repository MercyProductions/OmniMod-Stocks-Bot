import { waitForAlpacaRequest } from './alpacaRequestGate.js';
const NEWS_ROOT = 'https://data.alpaca.markets/v1beta1/news';

/** Preserve source time semantics: created_at and updated_at are distinct Alpaca fields. */
export function normalizeAlpacaNewsArticle(article, { now = Date.now(), futureSkewMs = 5_000 } = {}) {
  const createdAt = Date.parse(article?.created_at || '');
  const updatedAt = article?.updated_at == null || article.updated_at === '' ? createdAt : Date.parse(article.updated_at);
  const symbols = Array.isArray(article?.symbols)
    ? [...new Set(article.symbols.map((symbol) => String(symbol).trim().toUpperCase()).filter((symbol) => /^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)))]
    : [];
  const headline = String(article?.headline || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240);
  const publisher = String(article?.source || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 100);
  let sourceUrl = null;
  try {
    const rawUrl = String(article?.url || '');
    const url = rawUrl.length <= 1_000 ? new URL(rawUrl) : null;
    if (url?.protocol === 'https:' && url.hostname && !url.username && !url.password) sourceUrl = url.toString();
  } catch { /* source URL is optional when the publisher is identified */ }
  if (!Number.isFinite(now) || !Number.isFinite(futureSkewMs) || futureSkewMs < 0
    || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt) || !symbols.length || !headline
    || (!publisher && !sourceUrl) || createdAt > now + futureSkewMs || updatedAt > now + futureSkewMs) return null;
  return { id: article?.id == null ? null : String(article.id).slice(0, 100), provider: 'Alpaca', symbols,
    createdAt, updatedAt, activityAt: Math.max(createdAt, updatedAt), headline, publisher, sourceUrl };
}

/** Read-only recent-news coverage for symbols with an independently reviewed catalyst status.
 * Headlines are never sentiment-scored; coverage gaps and newer stories invalidate clearance.
 */
export async function fetchAlpacaCatalystNews(symbols, {
  key, secret, fetcher = fetch, now = Date.now(), reviewWindowMs = 30 * 60_000,
  batchSize = 10, maxPages = 5, concurrency = 4, metrics = [], requestGate = waitForAlpacaRequest,
} = {}) {
  if (!key || !secret) throw new Error('Alpaca credentials are required for Alpaca catalyst news.');
  if (!Array.isArray(symbols) || symbols.some((symbol) => !/^[A-Z][A-Z0-9.-]{0,14}$/.test(String(symbol)))) {
    throw new TypeError('Alpaca catalyst symbols must be valid uppercase tickers.');
  }
  if (!(reviewWindowMs > 0) || !Number.isFinite(reviewWindowMs) || !(batchSize > 0) || !(maxPages > 0) || !(concurrency > 0)) {
    throw new RangeError('Alpaca catalyst request limits must be positive.');
  }
  const unique = [...new Set(symbols)];
  const bySymbol = new Map(unique.map((symbol) => [symbol, []]));
  const incomplete = new Set();
  const headers = { accept: 'application/json', 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
  const batches = [];
  for (let i = 0; i < unique.length; i += batchSize) batches.push(unique.slice(i, i + batchSize));
  const loadBatch = async (batch) => {
    let pageToken = '';
    let page = 0;
    try {
      do {
        const params = new URLSearchParams({ symbols: batch.join(','), start: new Date(now - reviewWindowMs).toISOString(), end: new Date(now).toISOString(), sort: 'desc', limit: '50' });
        if (pageToken) params.set('page_token', pageToken);
        let startedAt = Date.now(), requestAttempted = false, requestMetric = null;
        let response;
        try {
          const grant = await requestGate(key);
          startedAt = Date.now(); requestAttempted = true;
          response = await fetcher(`${NEWS_ROOT}?${params}`, { headers, signal: AbortSignal.timeout(15_000) });
          await requestGate.observe?.(key, response.headers, { reservationId: grant?.reservationId, status: response.status });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          requestMetric = { provider: 'Alpaca', operation: 'catalyst_news', status: response.status, latencyMs: Date.now() - startedAt,
            rateLimit: rateLimitHeaders(response.headers) };
          metrics.push(requestMetric);
          if (!Array.isArray(payload?.news)) throw new Error('News response missing article array.');
          for (const article of payload.news) {
            const normalized = normalizeAlpacaNewsArticle(article, { now });
            if (!normalized) {
              batch.forEach((symbol) => incomplete.add(symbol));
              continue;
            }
            for (const symbol of normalized.symbols) if (bySymbol.has(symbol) && batch.includes(symbol)) {
              bySymbol.get(symbol).push(normalized);
            }
          }
          pageToken = String(payload.next_page_token || '');
          page += 1;
        } catch (error) {
          const message = String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180);
          if (requestMetric) requestMetric.error = message;
          else metrics.push({ provider: 'Alpaca', operation: 'catalyst_news', status: Number(response?.status) || 0,
            ...(requestAttempted ? {} : { requestAttempted: false, budgetRejection: error.code || 'ALPACA_BUDGET_UNAVAILABLE' }),
            latencyMs: Date.now() - startedAt, rateLimit: rateLimitHeaders(response?.headers),
            error: message });
          throw error;
        }
      } while (pageToken && page < maxPages);
      if (pageToken) batch.forEach((symbol) => incomplete.add(symbol));
    } catch {
      batch.forEach((symbol) => incomplete.add(symbol));
    }
  };
  for (let i = 0; i < batches.length; i += concurrency) await Promise.all(batches.slice(i, i + concurrency).map(loadBatch));
  return { bySymbol, incomplete, diagnostics: { status: incomplete.size ? 'partial' : 'complete', symbols: unique.length,
    batches: batches.length, incompleteSymbols: [...incomplete], articles: [...bySymbol.values()].reduce((sum, rows) => sum + rows.length, 0) } };
}

function rateLimitHeaders(headers) {
  const read = (name) => {
    if (typeof headers?.get === 'function') return headers.get(name);
    const key = Object.keys(headers ?? {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : null;
  };
  const number = (name) => {
    const raw = read(name);
    const value = raw == null || String(raw).trim() === '' ? null : Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const limit = number('X-RateLimit-Limit');
  const remaining = number('X-RateLimit-Remaining');
  const reset = number('X-RateLimit-Reset');
  if (limit === null && remaining === null && reset === null) return null;
  return { limit, remaining, reset,
    utilizationPct: limit > 0 && remaining !== null ? Number(Math.max(0, (limit - remaining) / limit * 100).toFixed(2)) : null };
}

export function applyAlpacaCatalystNews(rows, news, { now = Date.now() } = {}) {
  return rows.map((row) => {
    const symbol = String(row.signal?.underlyingSymbol ?? '').trim().toUpperCase();
    const articles = news.bySymbol.get(symbol) || [];
    const reviewAt = Number.isFinite(Number(row.signal?.catalystReview?.reviewedAt))
      ? Number(row.signal.catalystReview.reviewedAt) : Date.parse(row.signal?.catalystReview?.reviewedAt || '');
    let reason = null;
    if (news.incomplete.has(symbol)) reason = 'Alpaca recent-news coverage incomplete; catalyst clearance blocked.';
    else if (!Number.isFinite(reviewAt) || articles.some((article) => article.activityAt > reviewAt)) reason = 'A recent company-news item or update is newer than the catalyst review; refresh the review before analysis.';
    return { ...row, signal: { ...row.signal,
      catalystNews: articles.map((article) => ({ ...article, createdAt: new Date(article.createdAt).toISOString(),
        updatedAt: new Date(article.updatedAt).toISOString(), activityAt: new Date(article.activityAt).toISOString() })),
      catalystNewsCheckedAt: new Date(now).toISOString(),
      ...(reason ? { catalystReview: { status: 'blocked', source: 'Alpaca recent company news', summary: reason, reviewedAt: new Date(now).toISOString() } } : {}),
    }, ...(reason ? { catalystNewsStatus: reason.startsWith('Alpaca') ? 'coverage-incomplete' : 'review-invalidated' } : { catalystNewsStatus: 'clear' }) };
  });
}
