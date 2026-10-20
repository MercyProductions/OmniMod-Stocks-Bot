import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { OPTION_CATALYST_SOURCES } from '../../shared/optionEntryEvidence.js';
import { tradierUnderlyingSymbol } from '../../shared/optionContractIdentity.js';
import { fetchFinnhubEconomicCalendar } from '../../shared/finnhubEconomicCalendar.js';
import { fetchAlpacaCatalystNews, applyAlpacaCatalystNews } from '../../shared/alpacaCatalystNews.js';
import { waitForAlpacaRequest } from '../../shared/alpacaRequestGate.js';
import { marketDateAt } from '../../shared/marketDate.js';

/** Read current clearances for pending entries, even when they left this scan's shortlist. */
export async function loadPendingOptionReviews(orders, { env = process.env, manualReviews, manualSessionFile,
  now = Date.now(), clockNow = Date.now, fetchImpl = fetch, providerMetrics = [],
  requestGate = waitForAlpacaRequest, budgetMs = 8000 } = {}) {
  const started = clockNow(), at = () => now + Math.max(0, clockNow() - started), deadline = started + budgetMs;
  if (!(budgetMs > 0 && budgetMs <= 8000)) throw new RangeError('Invalid pending Options review budget.');
  const pending = orders.filter(order => order?.status === 'reserved' && order?.assetClass === 'option' && order?.owner === 'options'
    && OPTION_CATALYST_SOURCES.includes(order.option?.entryValidation?.catalystSource));
  const result = new Map();
  if (!pending.length) return result;
  const blocked = summary => ({ status: 'blocked', source: 'Options entry review', summary, reviewedAt: new Date(at()).toISOString() });
  const fetcher = (url, init = {}) => {
    const remaining = deadline - clockNow();
    if (remaining <= 0) throw new Error('Pending option review budget exhausted.');
    return fetchImpl(url, { ...init, signal: AbortSignal.any([init.signal, AbortSignal.timeout(Math.max(1, Math.ceil(remaining)))].filter(Boolean)) });
  };
  const manual = new Map();
  let manualCheckedAt = at(), calendarCheckedAt = at(), newsCheckedAt = at();
  if (pending.some(order => !order.option.entryValidation.catalystSource.includes('finnhub'))) {
    try {
      if (manualReviews === undefined) {
        const raw = await readFile(resolve(manualSessionFile || env.OPTIONS_CATALYST_REVIEW_FILE || 'examples/catalyst-reviews.json'), 'utf8');
        if (raw.length > 1024 * 1024) throw new Error('Review file exceeds budget.');
        const file = JSON.parse(raw);
        manualReviews = manualSessionFile ? file.signals?.map(row => ({ ...row.signal?.catalystReview,
          symbol: row.signal?.underlyingSymbol })) : file.reviews;
      }
      if (!Array.isArray(manualReviews)) throw new Error('Review rows missing.');
      for (const review of manualReviews) {
        const key = tradierUnderlyingSymbol(review?.symbol);
        if (key) manual.set(key, manual.has(key) ? blocked('Duplicate underlying reviews require resolution.') : review);
      }
    } catch { /* Missing/malformed current input never falls back to the reserved review. */ }
    manualCheckedAt = at();
  }
  const symbolsFor = source => [...new Set(pending.filter(order => order.option.entryValidation.catalystSource.includes(source))
    .map(order => tradierUnderlyingSymbol(order.option.underlyingSymbol)?.replaceAll('/', '.')).filter(Boolean))];
  let calendar, news;
  const calendarSymbols = symbolsFor('finnhub'), newsSymbols = symbolsFor('alpaca');
  if (calendarSymbols.length) {
    try {
      calendar = await fetchFinnhubEconomicCalendar({ token: env.FINNHUB_API_KEY || '', marketDate: marketDateAt(at(), 'America/New_York'),
        instruments: calendarSymbols, countryCodesByInstrument: Object.fromEntries(calendarSymbols.map(symbol => [symbol, ['US']])),
        now: at(), clock: at, fetcher, metrics: providerMetrics, cache: false, maxAttempts: 1, maxRetryWaitMs: 0 });
    } catch { calendar = null; }
    calendarCheckedAt = at();
  }
  if (newsSymbols.length) {
    const gate = key => requestGate(key, { maxWaitMs: Math.max(0, Math.min(2000, deadline - clockNow())) });
    gate.observe = (...args) => requestGate.observe?.(...args);
    try {
      news = await fetchAlpacaCatalystNews(newsSymbols, { key: env.ALPACA_API_KEY_ID || env.APCA_API_KEY_ID,
        secret: env.ALPACA_API_SECRET_KEY || env.APCA_API_SECRET_KEY, now: at(), fetcher, metrics: providerMetrics, requestGate: gate,
        concurrency: 2 });
    } catch { news = null; }
    newsCheckedAt = at();
  }
  for (const order of pending) {
    const symbol = tradierUnderlyingSymbol(order.option.underlyingSymbol)?.replaceAll('/', '.'), source = order.option.entryValidation.catalystSource;
    let review = source.includes('finnhub') ? calendar?.reviews?.[symbol] : manual.get(tradierUnderlyingSymbol(symbol));
    review ??= blocked('Current catalyst clearance is unavailable.');
    if (source.includes('alpaca')) review = news ? applyAlpacaCatalystNews([{ signal: { underlyingSymbol: symbol, catalystReview: review } }], news,
      { now: at() })[0].signal.catalystReview : blocked('Current company-news coverage is unavailable.');
    if (clockNow() >= deadline) review = blocked('Current catalyst lookup exceeded its time budget.');
    const checks = [source.includes('finnhub') ? calendarCheckedAt : manualCheckedAt, ...(source.includes('alpaca') ? [newsCheckedAt] : [])];
    result.set(order.orderId, { source, checkedAt: new Date(Math.min(...checks)).toISOString(), review });
  }
  return result;
}
