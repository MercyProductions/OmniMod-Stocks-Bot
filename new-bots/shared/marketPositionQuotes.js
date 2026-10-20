import { fetchAlpacaEtfPositionMarks } from '../etfs-etps/src/alpacaMarketData.js';
import { fetchTradierOptionPositionMarks } from '../options/src/tradierMarketData.js';
import { fetchDatabentoFuturePositionMarks } from '../futures/src/databentoLiveMarks.js';
import { requestForexJson } from '../forex/src/providerRequest.js';
import { loadForexPositionQuotes } from '../forex/src/positionQuotes.js';
import { getForexMarketSession } from '../forex/src/marketSession.js';
import { fetchStockPositionQuotes } from './stockPositionQuotes.js';

const value = (env, key, fallback) => String(env[key] ?? '').trim() || fallback;
const number = (env, key, fallback) => Number(value(env, key, fallback));
export function positionMonitorLimits(bot, env = {}) {
  const fields = {
    crypto: ['SHARED_MAX_QUOTE_AGE_MS', 15000, 'SHARED_MAX_SPREAD_PCT', 0.5, 'SHARED'],
    stocks: ['SHARED_MAX_QUOTE_AGE_MS', 15000, 'SHARED_MAX_SPREAD_PCT', 0.5, 'SHARED'],
    forex: ['MAX_QUOTE_AGE_SECONDS', 120, 'FOREX_MAX_SPREAD_PCT', 0.03, 'FOREX'],
    futures: ['FUTURES_MAX_POSITION_QUOTE_AGE_MS', 5000, 'FUTURES_MAX_SPREAD_PCT', 0.05, 'FUTURES'],
    options: ['OPTIONS_MAX_QUOTE_AGE_MS', 10000, 'OPTIONS_MAX_COMBO_SPREAD_PCT', 25, 'OPTIONS'],
    'etfs-etps': ['ETF_MAX_QUOTE_AGE_MS', 15000, 'ETF_MAX_SPREAD_PCT', 0.5, 'ETF'],
  }[bot];
  if (!fields) throw new TypeError('Unknown position monitor owner.');
  const maxQuoteAgeMs = number(env, fields[0], fields[1]) * (bot === 'forex' ? 1000 : 1);
  const maxSpreadPct = number(env, fields[2], fields[3]);
  const maxOpenMarkAgeMs = number(env, `${fields[4]}_MAX_OPEN_MARK_AGE_MS`, 300000);
  if (![maxQuoteAgeMs, maxOpenMarkAgeMs].every((n) => Number.isFinite(n) && n > 0)
    || !Number.isFinite(maxSpreadPct) || maxSpreadPct < 0) throw new TypeError('Invalid position monitoring limits.');
  return { maxQuoteAgeMs, maxSpreadPct, maxOpenMarkAgeMs };
}

/** Existing authorized quote adapters only. No universe, history, news, strategy or order APIs. */
export async function loadMarketPositionQuotes(bot, orders, { env = process.env, clock = Date.now,
  providerMetrics = [], fetcher = fetch, connect } = {}) {
  const limits = positionMonitorLimits(bot, env);
  const unavailable = (status) => ({ marks: [], diagnostics: { status, positions: orders.length, quoted: 0 } });
  if (!orders.length) return unavailable('no_active_positions');
  if (bot === 'stocks') return fetchStockPositionQuotes(orders, { env, clock, fetcher, providerMetrics });
  if (bot === 'crypto') {
    const { fetchCryptoPositionQuotes } = await import('../../crypto-bot/src/positionQuotes.js');
    return fetchCryptoPositionQuotes(orders, { env, clock });
  }
  if (bot === 'etfs-etps') {
    if (value(env, 'ETF_SOURCE', 'fixture') !== 'alpaca') return unavailable('source_not_configured');
    return fetchAlpacaEtfPositionMarks(orders, { env, now: new Date(clock()), clock, fetcher, providerMetrics });
  }
  if (bot === 'options') {
    const primary = value(env, 'OPTIONS_SOURCE', 'manual') === 'tradier';
    const independent = ['auto', 'tradier'].includes(value(env, 'OPTIONS_INDEPENDENT_PAPER_SOURCE', 'auto'));
    if (!primary && !independent) return unavailable('source_not_configured');
    return fetchTradierOptionPositionMarks(orders, { token: value(env, 'TRADIER_TOKEN', ''),
      environment: value(env, 'TRADIER_ENV', 'sandbox'), now: clock(), clockNow: clock, fetchImpl: fetcher,
      maxQuoteAgeMs: limits.maxQuoteAgeMs, maxLegSkewMs: number(env, 'OPTIONS_MAX_LEG_SKEW_MS', 3000), providerMetrics });
  }
  if (bot === 'futures') {
    if (value(env, 'FUTURES_POSITION_MARK_SOURCE', 'manual') !== 'databento-live') return unavailable('source_not_configured');
    return fetchDatabentoFuturePositionMarks(orders, { apiKey: value(env, 'DATABENTO_API_KEY', ''),
      dataset: value(env, 'DATABENTO_DATASET', 'GLBX.MDP3'), now: clock(), clock,
      maxQuoteAgeMs: limits.maxQuoteAgeMs, maxTransportLagMs: number(env, 'FUTURES_MAX_TRANSPORT_LAG_MS', 2000),
      timeoutMs: number(env, 'FUTURES_LIVE_QUOTE_TIMEOUT_MS', 8000), metrics: providerMetrics, ...(connect ? { connect } : {}) });
  }
  if (value(env, 'FOREX_SOURCE', 'disabled') !== 'oanda-practice') return unavailable('source_not_configured');
  if (value(env, 'OANDA_ENV', 'practice') !== 'practice') return unavailable('practice_endpoint_required');
  if (!env.OANDA_API_TOKEN || !env.OANDA_ACCOUNT_ID) return unavailable('credentials_missing');
  const instruments = [...new Set(orders.map((row) => row.instrumentKey))];
  if (instruments.some((instrument) => !/^[A-Z]{3}_[A-Z]{3}$/.test(instrument))) return unavailable('invalid_position_instrument');
  const calendar = { closedSessionDates: value(env, 'FOREX_CLOSED_SESSION_DATES', '').split(',').filter(Boolean),
    earlyClosesEt: JSON.parse(value(env, 'FOREX_EARLY_CLOSES_ET_JSON', '{}')) };
  const result = await loadForexPositionQuotes({ instruments, now: clock(), clock, maxQuoteAgeMs: limits.maxQuoteAgeMs,
    fetchPrices: (pairs) => {
      const url = new URL(`https://api-fxpractice.oanda.com/v3/accounts/${encodeURIComponent(env.OANDA_ACCOUNT_ID)}/pricing`);
      url.searchParams.set('instruments', pairs.join(','));
      return requestForexJson(url.toString(), { headers: { authorization: `Bearer ${env.OANDA_API_TOKEN}` },
        fetcher, clock, metrics: providerMetrics, operation: 'position-pricing', instruments: pairs, timeoutMs: 12000 });
    } });
  const marks = orders.filter((order) => result.quotes.has(order.instrumentKey)).map((order) => ({ orderId: order.orderId,
    quote: result.quotes.get(order.instrumentKey), sessionOpen: getForexMarketSession(clock(), { ...calendar, instrument: order.instrumentKey }).isOpen }));
  return { marks, diagnostics: { status: result.failures.length ? 'partial' : 'complete', positions: orders.length,
    quoted: marks.length, failures: result.failures } };
}
