import { requestAlpacaJson } from './alpacaHttp.js';
import { hasExplicitFiniteAmount } from './strategyConfig.js';
import { parseAlpacaStockQuote } from './stockQuoteEvidence.js';

const zonedParts = value => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(new Date(value)).map(part => [part.type, part.value]));
const marketDate = value => { const p = zonedParts(value); return `${p.year}-${p.month}-${p.day}`; };
function sessionTime(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time ?? '')) return NaN;
  const [y, m, d] = date.split('-').map(Number), [h, min] = time.split(':').map(Number);
  const desired = Date.UTC(y, m - 1, d, h, min);
  let at = desired;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(at);
    at += desired - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  }
  return at;
}

/** Current session evidence is rechecked at the ledger boundary, not just when the HTTP request finishes. */
export function stockMarkSessionOpen(mark, now) {
  const s = mark?.stockSession;
  return Boolean(s && s.isOpen === true && Number.isFinite(now) && now >= s.openTime && now < s.closeTime
    && now - s.clockTime <= 30000 && s.clockTime <= now + 5000
    && Date.parse(mark.quote?.time) >= s.openTime && Date.parse(mark.quote?.time) < s.closeTime);
}

/** Quotes for existing Stocks paper positions only. No discovery, history or broker order calls. */
export async function fetchStockPositionQuotes(orders, { env = {}, fetcher = fetch, clock = Date.now, providerMetrics = [] } = {}) {
  const positions = orders.filter(o => o?.owner === 'stocks' && o.assetClass === 'stock' && ['reserved', 'filled', 'open'].includes(o.status));
  const reasons = {}, reject = (code, count = 1) => { reasons[code] = (reasons[code] || 0) + count; };
  const unavailable = status => ({ marks: [], diagnostics: { status, rejectionReasons: { [status]: positions.length } } });
  if (!positions.length) return unavailable('no_active_positions');
  const feed = String(env.ALPACA_DATA_FEED || 'iex').trim().toLowerCase();
  if (!['iex', 'sip'].includes(feed)) return unavailable('current_iex_or_sip_feed_required');
  if (!env.ALPACA_API_KEY_ID || !env.ALPACA_API_SECRET_KEY) return unavailable('credentials_missing');
  const age = Number(env.SHARED_MAX_QUOTE_AGE_MS || 15000);
  if (!Number.isFinite(age) || age <= 0) throw new TypeError('Invalid stock position quote age.');
  const valid = positions.filter(o => typeof o.instrumentKey === 'string' && /^[A-Z][A-Z0-9.-]{0,9}$/.test(o.instrumentKey));
  reject('invalid_instrument_key', positions.length - valid.length);
  const symbols = [...new Set(valid.map(o => o.instrumentKey))];
  if (!symbols.length) return unavailable('invalid_instrument_key');
  const headers = { accept: 'application/json', 'APCA-API-KEY-ID': env.ALPACA_API_KEY_ID, 'APCA-API-SECRET-KEY': env.ALPACA_API_SECRET_KEY };
  const request = (url, operation) => requestAlpacaJson(url, headers, fetcher, providerMetrics, `Alpaca Stocks position ${operation}`);
  const date = marketDate(clock());
  const sessionResults = await Promise.allSettled([
    request('https://paper-api.alpaca.markets/v2/clock', 'clock'),
    request(`https://paper-api.alpaca.markets/v2/calendar?start=${date}&end=${date}`, 'calendar'),
  ]);
  if (sessionResults.some(row => row.status === 'rejected')) return unavailable('session_provider_failure');
  const [marketClock, calendar] = sessionResults.map(row => row.value);
  const days = Array.isArray(calendar) ? calendar.filter(day => day?.date === date) : [];
  if (days.length !== 1) return unavailable('missing_or_ambiguous_trading_session');
  const openTime = sessionTime(date, days[0].open), closeTime = sessionTime(date, days[0].close);
  const clockTime = typeof marketClock?.timestamp === 'string' ? Date.parse(marketClock.timestamp) : NaN;
  const session = { openTime, closeTime, clockTime, isOpen: marketClock?.is_open };
  const validClock = at => typeof session.isOpen === 'boolean' && Number.isFinite(clockTime)
    && clockTime <= at + 5000 && at - clockTime <= 30000 && marketDate(at) === date
    && Number.isFinite(openTime) && Number.isFinite(closeTime) && openTime < closeTime
    && (!session.isOpen || (clockTime >= openTime && clockTime < closeTime));
  if (!validClock(clock())) return unavailable('invalid_or_stale_market_clock');
  const marks = [];
  for (let offset = 0; offset < symbols.length; offset += 100) {
    const batch = symbols.slice(offset, offset + 100), batchOrders = valid.filter(o => batch.includes(o.instrumentKey));
    let payload;
    try {
      const query = new URLSearchParams({ symbols: batch.join(','), feed, currency: 'USD' });
      payload = await request(`https://data.alpaca.markets/v2/stocks/quotes/latest?${query}`, 'quotes');
    } catch { reject('quote_provider_failure', batchOrders.length); continue; }
    if (!payload?.quotes || typeof payload.quotes !== 'object' || Array.isArray(payload.quotes)) {
      reject('invalid_quote_response', batchOrders.length); continue;
    }
    for (const order of batchOrders) {
      const q = payload.quotes[order.instrumentKey], at = clock();
      const time = typeof q?.t === 'string' ? Date.parse(q.t) : NaN;
      const bid = hasExplicitFiniteAmount(q?.bp) ? Number(q.bp) : NaN, ask = hasExplicitFiniteAmount(q?.ap) ? Number(q.ap) : NaN;
      const reason = !q ? 'quote_missing' : !Number.isFinite(time) || time > at + 5000 || at - time > age ? 'stale_or_future_quote'
        : marketDate(time) !== date ? 'quote_outside_market_date' : !(bid > 0 && ask >= bid) ? 'invalid_bid_ask' : null;
      if (reason) { reject(reason); continue; }
      let quote;
      try { quote = parseAlpacaStockQuote(q, { symbol: order.instrumentKey, feed, source: 'latest', now: at, maxQuoteAgeMs: age }); }
      catch (error) { reject(error.code || 'stock_quote_evidence_required'); continue; }
      const mark = { orderId: order.orderId, quote, stockSession: session };
      mark.sessionOpen = stockMarkSessionOpen(mark, at);
      marks.push(mark);
    }
  }
  const completed = clock();
  const currentMarks = marks.filter(mark => {
    const reason = !validClock(completed) ? 'market_clock_aged_during_collection'
      : completed - Date.parse(mark.quote.time) > age ? 'quote_aged_during_collection' : null;
    if (reason) { reject(reason); return false; }
    mark.sessionOpen = stockMarkSessionOpen(mark, completed);
    return true;
  });
  return { marks: currentMarks, diagnostics: { status: currentMarks.length === positions.length ? 'complete' : 'partial',
    feed, quoteCoverage: feed === 'sip' ? 'consolidated' : 'single_venue', symbolsRequested: symbols.length,
    rejectionReasons: Object.fromEntries(Object.entries(reasons).filter(([, n]) => n > 0)) } };
}
