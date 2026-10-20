import { localDateKey, marketCloseTime, marketSession } from './time.js';
import { fetchIssuerAnnualFundamentals } from './eventIntelligence.js';
import { config } from './config.js';
import { alpacaThrottleDelayMs, waitForAlpacaRequest } from './alpacaRequestGate.js';

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const change = (a, b) => (b > 0 ? (a / b - 1) * 100 : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const positive = (v) => v !== null && v !== undefined && Number.isFinite(Number(v)) && Number(v) > 0;
const sma = (bars, end, length) => (end + 1 >= length ? mean(bars.slice(end - length + 1, end + 1).map((b) => b.close)) : null);
export const INVESTMENT_HORIZONS = Object.freeze([5, 20, 60]);
export const LONG_TERM_PRICE_WINDOWS = Object.freeze([
  { sessions: 126, label: 'about 6 months' },
  { sessions: 252, label: 'about 1 year' },
  { sessions: 504, label: 'about 2 years' },
  { sessions: 756, label: 'about 3 years' },
  { sessions: 1250, label: 'about 5 years' },
]);

function alpacaRateLimit(headers) {
  const read = (name) => {
    const raw = headers?.get?.(name);
    const value = raw == null || raw === '' ? NaN : Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const limit = read('X-RateLimit-Limit'), remaining = read('X-RateLimit-Remaining'), reset = read('X-RateLimit-Reset');
  return limit === null && remaining === null && reset === null ? null : { limit, remaining, reset };
}

async function fetchInvestmentBarsPage(url, headers, options, symbol) {
  const fetcher = options.fetcher || fetch;
  const metrics = options.providerMetrics || [];
  const requestGate = options.requestGate === null ? null : (options.requestGate || waitForAlpacaRequest);
  const retrySleep = options.retrySleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const clock = options.clock || Date.now;
  const maxRetryWaitMs = Number.isFinite(Number(options.maxRetryWaitMs)) ? Math.max(0, Number(options.maxRetryWaitMs)) : 10_000;
  const credential = String(headers['APCA-API-KEY-ID'] || '');
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let cooldownDelayMs = 0;
    let gateResult;
    if (credential && requestGate) {
      const result = gateResult = await requestGate(credential);
      cooldownDelayMs = Number.isFinite(Number(result?.cooldownDelayMs)) ? Math.max(0, Number(result.cooldownDelayMs)) : 0;
    }
    const startedAt = clock();
    let response;
    let requestMetric = null;
    try {
      response = await fetcher(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (credential) await requestGate?.observe?.(credential, response.headers, { reservationId: gateResult?.reservationId, status: response.status });
      if (!response.ok) {
        const error = new Error(`Alpaca HTTP ${response.status}`);
        error.status = Number(response.status) || 0;
        error.retryAfter = response.headers?.get?.('Retry-After') ?? null;
        requestMetric = { provider: 'Alpaca', operation: 'investment-daily-bars', symbol, attempt: attempt + 1,
          status: error.status, latencyMs: Math.max(0, clock() - startedAt), cooldownDelayMs,
          ...(alpacaRateLimit(response.headers) ? { rateLimit: alpacaRateLimit(response.headers) } : {}), error: `HTTP ${error.status}` };
        metrics.push(requestMetric);
        throw error;
      }
      let payload;
      try { payload = await response.json(); }
      catch {
        requestMetric = { provider: 'Alpaca', operation: 'investment-daily-bars', symbol, attempt: attempt + 1,
          status: response.status, latencyMs: Math.max(0, clock() - startedAt), cooldownDelayMs, error: 'invalid_json' };
        metrics.push(requestMetric);
        const error = new Error('Alpaca returned invalid JSON.');
        error.permanent = true;
        throw error;
      }
      if (!Array.isArray(payload?.bars?.[symbol])) {
        requestMetric = { provider: 'Alpaca', operation: 'investment-daily-bars', symbol, attempt: attempt + 1,
          status: response.status, latencyMs: Math.max(0, clock() - startedAt), cooldownDelayMs, error: 'invalid_bars_payload' };
        metrics.push(requestMetric);
        const error = new Error('Alpaca returned an invalid historical-bars response.');
        error.permanent = true;
        throw error;
      }
      requestMetric = { provider: 'Alpaca', operation: 'investment-daily-bars', symbol, attempt: attempt + 1,
        status: response.status, latencyMs: Math.max(0, clock() - startedAt), cooldownDelayMs,
        ...(alpacaRateLimit(response.headers) ? { rateLimit: alpacaRateLimit(response.headers) } : {}) };
      metrics.push(requestMetric);
      return payload;
    } catch (error) {
      lastError = error;
      const status = Number(error?.status) || Number(response?.status) || 0;
      if (!requestMetric) {
        requestMetric = { provider: 'Alpaca', operation: 'investment-daily-bars', symbol, attempt: attempt + 1,
          status, latencyMs: Math.max(0, clock() - startedAt), cooldownDelayMs, error: status ? `HTTP ${status}` : String(error?.name || 'request_failed').slice(0, 80) };
        metrics.push(requestMetric);
      }
      const retryable = [429, 500, 502, 503, 504].includes(status)
        || (!status && ['TimeoutError', 'AbortError', 'TypeError'].includes(error?.name));
      const delayMs = status === 429
        ? alpacaThrottleDelayMs(response?.headers, clock(), 1_000 * (2 ** attempt))
        : 1_000 * (2 ** attempt);
      if (status === 429 && credential && Number.isFinite(delayMs)) await requestGate?.defer?.(credential, delayMs);
      if (error?.permanent || !retryable || attempt === 2) break;
      if (!Number.isFinite(delayMs) || delayMs > maxRetryWaitMs) {
        requestMetric.retryDeferred = true;
        requestMetric.requestedRetryDelayMs = delayMs;
        break;
      }
      requestMetric.retry = true;
      requestMetric.retryDelayMs = delayMs;
      if (status !== 429 || !requestGate || !credential) await retrySleep(delayMs);
    }
  }
  throw lastError;
}

function longTermPriceContext(aligned, benchmark, completeCoverage) {
  const end = aligned.length - 1;
  return LONG_TERM_PRICE_WINDOWS.map(({ sessions, label }) => {
    const enoughHistory = completeCoverage && end >= sessions;
    if (!enoughHistory) return { sessions, label, status: completeCoverage ? 'insufficient_history' : 'incomplete_alignment',
      assetAdjustedReturnPct: null, benchmarkAdjustedReturnPct: null, excessAdjustedReturnPct: null,
      requiredSessions: sessions + 1, availableSessions: aligned.length };
    const assetReturn = change(aligned[end].close, aligned[end - sessions].close);
    const benchmarkReturn = change(benchmark[end].close, benchmark[end - sessions].close);
    return { sessions, label, status: 'observed', startDate: aligned[end - sessions].date, endDate: aligned[end].date,
      assetAdjustedReturnPct: assetReturn, benchmarkAdjustedReturnPct: benchmarkReturn,
      excessAdjustedReturnPct: assetReturn - benchmarkReturn };
  });
}

function benchmarkStressContext(bars, annualPeriods = 252) {
  const returns = bars.slice(1).map((bar, index) => Number(bar.close) / Number(bars[index].close) - 1)
    .filter(Number.isFinite);
  const volatilityFor = (sample) => {
    if (sample.length < 20) return null;
    const average = mean(sample);
    const variance = mean(sample.map((value) => (value - average) ** 2));
    return Math.sqrt(variance * annualPeriods) * 100;
  };
  const currentVolatility = volatilityFor(returns.slice(-20));
  const historicalVolatility = [];
  for (let end = Math.max(19, returns.length - 251); end < returns.length; end += 1) {
    const value = volatilityFor(returns.slice(end - 19, end + 1));
    if (Number.isFinite(value)) historicalVolatility.push(value);
  }
  const volatilityTolerance = Number.isFinite(currentVolatility) ? Math.max(1e-10, Math.abs(currentVolatility) * 1e-6) : 0;
  const volatilityPercentile = Number.isFinite(currentVolatility) && historicalVolatility.length >= 40
    ? (historicalVolatility.filter((value) => value < currentVolatility - volatilityTolerance).length
      + historicalVolatility.filter((value) => Math.abs(value - currentVolatility) <= volatilityTolerance).length / 2) / historicalVolatility.length * 100
    : null;
  const volatilityRegime = volatilityPercentile === null ? 'insufficient_history'
    : volatilityPercentile < 25 ? 'lower_quartile'
      : volatilityPercentile >= 90 ? 'extreme' : volatilityPercentile >= 75 ? 'elevated' : 'typical';
  const trailing = bars.slice(-252);
  const peak = Math.max(...trailing.map((bar) => Number(bar.close)).filter(positive));
  const drawdownPct = peak > 0 && positive(bars.at(-1)?.close) ? (Number(bars.at(-1).close) / peak - 1) * 100 : null;
  return { annualizedVolatilityPct: currentVolatility, volatilityPercentile, volatilityRegime,
    volatilityWindows: historicalVolatility.length, drawdownFrom252ObservationPeakPct: drawdownPct };
}

export function classifyBenchmarkRegime(bars = []) {
  const end = bars.length - 1;
  const latest = bars[end];
  if (end < 219 || !latest) return { label: 'insufficient_history', asOf: latest?.date || null, method: 'Requires 220 completed daily closes.' };
  const average50 = sma(bars, end, 50), average200 = sma(bars, end, 200), prior50 = sma(bars, end - 20, 50);
  const rising50 = average50 > prior50, falling50 = average50 < prior50;
  const label = latest.close > average200 && average50 > average200 && rising50 ? 'risk_on'
    : latest.close < average200 && average50 < average200 && falling50 ? 'risk_off' : 'mixed';
  return { label, asOf: latest.date, close: latest.close, sma50: average50, sma200: average200,
    sma50Change20Pct: change(average50, prior50),
    ...benchmarkStressContext(bars, 252),
    method: 'Price-only descriptive regime: trend uses close/SMA50/SMA200; 20-observation realized volatility is ranked against up to 252 trailing rolling observations (annualized using 252 periods); drawdown is from the trailing 252-observation peak. No macro, breadth, or credit data; not a crash predictor and not used to alter asset scores.' };
}

export function annualizedMetricGrowth(history = []) {
  const candidates = history.filter((row) => row && row.value !== null && row.value !== undefined
    && Number.isFinite(Number(row.value)) && Number(row.value) > 0 && Number.isFinite(Date.parse(`${row.periodEnd}T00:00:00Z`)))
    .sort((a, b) => String(a.periodEnd).localeCompare(String(b.periodEnd)));
  const rows = candidates.slice(-3);
  if (rows.length < 3) return null;
  const gaps = rows.slice(1).map((row, index) => (Date.parse(`${row.periodEnd}T00:00:00Z`) - Date.parse(`${rows[index].periodEnd}T00:00:00Z`)) / 86_400_000);
  if (gaps.some((days) => days < 330 || days > 400)) return null;
  const elapsedYears = gaps.reduce((sum, days) => sum + days, 0) / 365.2425;
  const pct = (Math.pow(Number(rows.at(-1).value) / Number(rows[0].value), 1 / elapsedYears) - 1) * 100;
  return Number.isFinite(pct) ? { pct, from: rows[0].periodEnd, through: rows.at(-1).periodEnd, years: elapsedYears, periods: rows.length } : null;
}

export function estimateAnnualTradingMultiples(price, priceAsOf, fundamentals, options = {}) {
  const filing = fundamentals?.filing || {};
  const metrics = fundamentals?.metrics || {};
  const priceValue = Number(price);
  const sharesMetric = metrics.sharesOutstanding;
  const shares = Number(sharesMetric?.value);
  const shareDate = sharesMetric?.periodEnd;
  const priceTime = Date.parse(`${priceAsOf}T00:00:00Z`);
  const sharesTime = Date.parse(`${shareDate}T00:00:00Z`);
  const unavailable = (reason) => ({ status: 'unavailable', reason, priceAsOf: priceAsOf || null,
    filingDate: filing.filedAt || null, shareCountAsOf: shareDate || null, annualPeriodEnd: filing.periodEnd || null });
  if (!positive(priceValue) || !Number.isFinite(priceTime)) return unavailable('No valid completed-session share price is available.');
  if (fundamentals?.status === 'unavailable' || fundamentals?.status === 'coverage_limited')
    return unavailable(fundamentals.reason || 'SEC annual facts are unavailable.');
  if (!filing.filedAt || filing.filedAt >= priceAsOf) return unavailable('The annual filing date is not known to precede the market-price date.');
  if (filing.form !== '10-K') return unavailable('Market-cap estimate withheld because a U.S. share-class/ADR mapping is not verified for this filing form.');
  if (options.postFilingSplit) return unavailable('Market-cap estimate withheld because a stock split occurred after the reported share-count date.');
  if (sharesMetric?.unit !== 'shares' || !positive(shares) || !Number.isFinite(sharesTime)) return unavailable('Reported common shares outstanding with a valid unit and date are unavailable.');
  const shareAgeDays = Math.floor((priceTime - sharesTime) / 86_400_000);
  if (shareAgeDays < 0 || shareAgeDays > 550) return unavailable('Reported shares are future-dated or more than 550 days old.');
  const marketCapEstimate = priceValue * shares;
  const annualValue = (key) => {
    const metric = metrics[key];
    return metric?.unit === 'USD' && metric.periodEnd === filing.periodEnd && metric.value !== null && metric.value !== undefined && metric.value !== '' && Number.isFinite(Number(metric.value))
      ? Number(metric.value) : null;
  };
  const multiple = (denominator) => Number.isFinite(denominator) && denominator > 0 ? marketCapEstimate / denominator : null;
  const revenue = annualValue('revenue'), netIncome = annualValue('netIncome'), freeCashFlow = annualValue('freeCashFlow');
  return { status: 'estimated', price: priceValue, priceAsOf, shareCount: shares, shareCountAsOf: shareDate,
    annualPeriodEnd: filing.periodEnd, filingDate: filing.filedAt, filingForm: filing.form,
    marketCapEstimate, priceToSales: multiple(revenue), priceToEarnings: multiple(netIncome),
    priceToFreeCashFlow: multiple(freeCashFlow), freeCashFlowYieldPct: Number.isFinite(freeCashFlow) ? freeCashFlow / marketCapEstimate * 100 : null,
    shareAgeDays, limitations: ['Market capitalization is an estimate using the last raw close and filing-date shares; current share count, multiple share classes and later corporate actions may differ.',
      'P/E, price/sales and price/FCF use one reported annual period, not forward estimates or an intrinsic-value model.',
      'Ratios are descriptive inputs only and do not determine whether the security is cheap, fair value, or a buy.'] };
}

export function estimateHistoricalAnnualMultiples(bars, filingInputs = [], events = [], priceAsOf = '') {
  const availableBars = (bars || []).filter((bar) => bar.date && bar.date <= priceAsOf
    && Number.isFinite(Number(bar.rawClose)) && Number(bar.rawClose) > 0).sort((a, b) => a.date.localeCompare(b.date));
  return (filingInputs || []).slice(0, 6).map((input) => {
    const filing = input?.filing || {};
    const unavailable = (reason) => ({ status: 'unavailable', fiscalYear: String(filing.periodEnd || '').slice(0, 4), filingDate: filing.filedAt || null, reason });
    if (filing.form !== '10-K' || !/^\d{4}-\d{2}-\d{2}$/.test(filing.filedAt || '')
      || !/^\d{4}-\d{2}-\d{2}$/.test(filing.periodEnd || '') || filing.filedAt <= filing.periodEnd)
      return unavailable('A valid filed U.S. 10-K and fiscal period are required.');
    const priceBar = availableBars.find((bar) => bar.date > filing.filedAt);
    if (!priceBar) return unavailable('No completed raw-price bar after the filing date is available.');
    const shares = input.sharesOutstanding;
    if (shares?.unit !== 'shares' || shares.periodEnd !== filing.periodEnd || !positive(shares.value))
      return unavailable('Positive common shares from the exact filing period are unavailable.');
    if (availableBars[0]?.date && shares.periodEnd < availableBars[0].date)
      return unavailable('The reported share-count date predates the available price and corporate-action history.');
    const shareAgeDays = Math.floor((Date.parse(`${priceBar.date}T00:00:00Z`) - Date.parse(`${shares.periodEnd}T00:00:00Z`)) / 86_400_000);
    if (shareAgeDays < 0 || shareAgeDays > 550) return unavailable('The reported share count is future-dated or more than 550 days old at the observation price.');
    if ((events || []).some((event) => event.type === 'split' && event.date > filing.periodEnd && event.date <= priceBar.date))
      return unavailable('A split between the reported share-count date and observation price prevents a comparable market-cap estimate.');
    const alignedValue = (metric) => metric?.unit === 'USD' && metric.periodEnd === filing.periodEnd
      && metric.value !== null && metric.value !== undefined && Number.isFinite(Number(metric.value)) ? Number(metric.value) : null;
    const marketCapEstimate = Number(priceBar.rawClose) * Number(shares.value);
    const multiple = (denominator) => Number.isFinite(denominator) && denominator > 0 ? marketCapEstimate / denominator : null;
    const revenue = alignedValue(input.revenue), netIncome = alignedValue(input.netIncome), freeCashFlow = alignedValue(input.freeCashFlow);
    return { status: 'estimated', fiscalYear: filing.periodEnd.slice(0, 4), filingDate: filing.filedAt,
      priceAsOf: priceBar.date, price: Number(priceBar.rawClose), shareCount: Number(shares.value),
      shareCountAsOf: shares.periodEnd, shareAgeDays, marketCapEstimate,
      priceToSales: multiple(revenue), priceToEarnings: multiple(netIncome), priceToFreeCashFlow: multiple(freeCashFlow) };
  });
}

export function summarizeHistoricalAnnualMultiples(observations = []) {
  const valid = (observations || []).filter((row) => row.status === 'estimated');
  const summary = {};
  for (const key of ['priceToSales', 'priceToEarnings', 'priceToFreeCashFlow']) {
    const values = valid.map((row) => row[key]).filter((value) => Number.isFinite(value) && value > 0);
    summary[key] = values.length >= 3 ? { sampleSize: values.length, min: Math.min(...values), max: Math.max(...values) }
      : { sampleSize: values.length, min: null, max: null };
  }
  return summary;
}

export function latestCompletedSession(now = new Date()) {
  const day = new Date(`${localDateKey(now, 'America/New_York')}T16:00:00Z`);
  for (let i = 0; i < 12; i += 1) {
    if (marketSession(day).state === 'regular' && marketCloseTime(day).getTime() + 15 * 60_000 <= now.getTime())
      return localDateKey(day, 'America/New_York');
    day.setUTCDate(day.getUTCDate() - 1);
  }
  return '';
}

// All OHLC use the same Yahoo adjusted-close factor. Raw price*raw volume is
// retained separately for liquidity, so dividends/splits cannot mix scales.
export function completedAdjustedDailyBars(result, now = new Date()) {
  const q = result?.indicators?.quote?.[0] || {};
  const adj = result?.indicators?.adjclose?.[0]?.adjclose || [];
  const byDate = new Map();
  for (const [i, timestamp] of (result?.timestamp || []).entries()) {
    if (!Number.isFinite(timestamp) || ![q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i], adj[i]].every(positive)) continue;
    const date = new Date(timestamp * 1000);
    // Include only completed sessions, with a 15-minute publication allowance.
    if (marketCloseTime(date).getTime() + 15 * 60_000 > now.getTime()) continue;
    if (q.high[i] < Math.max(q.open[i], q.close[i], q.low[i]) || q.low[i] > Math.min(q.open[i], q.close[i])) continue;
    const factor = adj[i] / q.close[i];
    const row = {
      date: localDateKey(date, 'America/New_York'),
      timestamp,
      open: q.open[i] * factor,
      high: q.high[i] * factor,
      low: q.low[i] * factor,
      close: Number(adj[i]),
      rawClose: Number(q.close[i]),
      dollarVolume: Math.max(0, Number(q.volume?.[i]) || 0) * q.close[i],
    };
    byDate.set(row.date, row);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function maxDrawdown(bars) {
  let peak = 0;
  let worst = 0;
  for (const bar of bars) {
    peak = Math.max(peak, bar.close);
    worst = Math.min(worst, change(bar.close, peak));
  }
  return worst;
}

function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * p)];
}

export function historicalDailyEvidence(bars, benchmark, horizon, roundTripCostBps = 20) {
  const outcomes = [];
  // The rule is fixed: above the completed 200-session average and stronger
  // than SPY over the selected horizon. Execute at the NEXT session's open.
  // Paths never overlap; the same rally cannot be counted dozens of times.
  for (let i = 199; i + horizon < bars.length; i += 1) {
    const relative = change(bars[i].close, bars[i - horizon].close) - change(benchmark[i].close, benchmark[i - horizon].close);
    if (bars[i].close <= sma(bars, i, 200) || relative <= 0) continue;
    const end = i + horizon;
    const netReturnPct = change(bars[end].close, bars[i + 1].open) - roundTripCostBps / 100;
    const benchmarkReturnPct = change(benchmark[end].close, benchmark[i + 1].open) - roundTripCostBps / 100;
    outcomes.push({
      signalDate: bars[i].date,
      entryDate: bars[i + 1].date,
      exitDate: bars[end].date,
      netReturnPct,
      benchmarkReturnPct,
      excessReturnPct: netReturnPct - benchmarkReturnPct,
    });
    i = end;
  }
  return {
    samples: outcomes.length,
    firstSignal: outcomes[0]?.signalDate || '',
    lastExit: outcomes.at(-1)?.exitDate || '',
    meanNetReturnPct: mean(outcomes.map((r) => r.netReturnPct)),
    meanExcessReturnPct: mean(outcomes.map((r) => r.excessReturnPct)),
    medianNetReturnPct: quantile(
      outcomes.map((r) => r.netReturnPct),
      0.5,
    ),
    downside10Pct: quantile(
      outcomes.map((r) => r.netReturnPct),
      0.1,
    ),
    roundTripCostBps,
    enoughExamples: outcomes.length >= 20,
    methodology:
      'Fixed trend/relative-strength rule; non-overlapping next-open paths; descriptive history, not a calibrated forecast.',
  };
}

export function analyzeInvestment(symbol, bars, benchmark, options = {}) {
  const horizon = INVESTMENT_HORIZONS.includes(Number(options.horizon)) ? Number(options.horizon) : 20;
  const now = options.now instanceof Date ? options.now : new Date();
  const spyByDate = new Map(benchmark.map((b) => [b.date, b]));
  const aligned = bars.filter((b) => spyByDate.has(b.date));
  const spy = aligned.map((b) => spyByDate.get(b.date));
  const marketRegime = classifyBenchmarkRegime(benchmark);
  const reasons = [];
  const eventRisk = cachedInvestmentEventRisk(options.eventContext, options.settings || {}, now);
  reasons.push(...eventRisk.blockers);
  if (aligned.length < 260) reasons.push('Need 260 completed sessions aligned with SPY.');
  const last = aligned.at(-1);
  if (!last)
    return { symbol, decision: 'WATCH_ONLY', score: null, horizon, marketRegime, longTermPriceContext: longTermPriceContext(aligned, spy, false), reasons: [...reasons, 'No aligned adjusted daily prices.'] };
  if (last.date !== benchmark.at(-1)?.date) reasons.push('Stock daily history lags the latest SPY session.');
  const completeCoverage = aligned.length === benchmark.filter((b) => b.date >= aligned[0].date && b.date <= last.date).length;
  const longTermContext = longTermPriceContext(aligned, spy, completeCoverage);
  if (!completeCoverage)
    reasons.push('Missing daily sessions inside the aligned benchmark history; historical analogs withheld.');
  const expectedSession = latestCompletedSession(now);
  if (last.date !== expectedSession)
    reasons.push(`Daily history does not reach the latest completed market session (${expectedSession || 'unknown'}).`);
  const end = aligned.length - 1;
  const sma50 = sma(aligned, end, 50),
    sma200 = sma(aligned, end, 200),
    prior50 = sma(aligned, end - 20, 50);
  const liquidity = mean(aligned.slice(-20).map((b) => b.dollarVolume));
  if (last.rawClose < 2 || liquidity < 10_000_000)
    reasons.push('Below the $2 price / $10m average daily dollar-volume research floor.');
  if (!sma200 || last.close <= sma200) reasons.push('Price is not above its 200-session trend.');
  if (!sma50 || sma50 <= sma200 || sma50 <= prior50) reasons.push('50-session trend is not rising above the 200-session trend.');
  const relativeReturns = Object.fromEntries(
    INVESTMENT_HORIZONS.map((h) => [
      h,
      end >= h ? change(last.close, aligned[end - h].close) - change(spy[end].close, spy[end - h].close) : null,
    ]),
  );
  const absoluteReturns = Object.fromEntries(
    INVESTMENT_HORIZONS.map((h) => [h, end >= h ? change(last.close, aligned[end - h].close) : null]),
  );
  if (symbol !== 'SPY' && !(relativeReturns[horizon] > 0))
    reasons.push(`No positive ${horizon}-session relative strength versus SPY.`);
  const persistenceRows = aligned
    .map((b, i) => ({ close: b.close, average: sma(aligned, i, 200) }))
    .slice(-60)
    .filter((b) => b.average);
  const trendPersistence = persistenceRows.length
    ? (persistenceRows.filter((b) => b.close > b.average).length / persistenceRows.length) * 100
    : null;
  const drawdownPct = change(last.close, Math.max(...aligned.slice(-252).map((b) => b.close)));
  const dailyReturns = aligned
    .slice(-61)
    .slice(1)
    .map((b, i) => Math.log(b.close / aligned.slice(-61)[i].close));
  const averageReturn = mean(dailyReturns) || 0;
  const annualizedVolatilityPct = Math.sqrt(mean(dailyReturns.map((r) => (r - averageReturn) ** 2)) || 0) * Math.sqrt(252) * 100;
  const corporateEvents = (options.events || []).filter((e) => e.date <= last.date && e.date >= aligned.at(-20)?.date);
  if (corporateEvents.some((e) => e.type === 'split'))
    reasons.push('A split occurred in the last 20 sessions; review corporate-action data.');
  const score =
    aligned.length < 260
      ? null
      : clamp(
          (trendPersistence || 0) * 0.3 +
            clamp(50 + relativeReturns[horizon] * 5, 0, 100) * 0.4 +
            clamp(100 + drawdownPct * 4, 0, 100) * 0.15 +
            clamp((liquidity / 100_000_000) * 100, 0, 100) * 0.15,
          0,
          100,
        );
  return {
    symbol,
    decision: symbol === 'SPY' ? 'BENCHMARK_RESEARCH' : reasons.length ? 'WATCH_ONLY' : 'RESEARCH_CANDIDATE',
    horizon,
    asOf: last.date,
    expectedSession,
    marketRegime,
    sessions: aligned.length,
    rawClose: last.rawClose,
    score: symbol === 'SPY' ? null : score,
    relativeReturns,
    absoluteReturns,
    longTermPriceContext: longTermContext,
    trendPersistence,
    drawdownPct,
    maxDrawdown126Pct: maxDrawdown(aligned.slice(-126)),
    annualizedVolatilityPct,
    averageDollarVolume20: liquidity,
    sma50,
    sma200,
    historical:
      symbol !== 'SPY' && completeCoverage && aligned.length >= 260
        ? historicalDailyEvidence(aligned, spy, horizon, options.roundTripCostBps ?? 20)
        : null,
    events: corporateEvents,
    eventRiskNotes: eventRisk.notes,
    eventCoverage:
      'Historical splits/dividends plus available cached event context; valuation and company fundamentals are not modeled.',
    reasons,
    explanation: 'Heuristic daily research rank; no forecast probability, price target, portfolio approval, or order.',
  };
}

export function cachedInvestmentEventRisk(context, settings = {}, now = new Date()) {
  const row = context?.asset;
  const ageMs = now.getTime() - Date.parse(context?.fetchedAt);
  if (!row || !Number.isFinite(ageMs))
    return {
      blockers: [],
      notes: ['Upcoming earnings, filings and macro context unavailable; fundamentals and valuation are not modeled.'],
    };
  const fresh = ageMs >= -5000 && ageMs <= 60 * 60_000;
  const blockers = [];
  const notes = [`Cached event context ${fresh ? 'current' : 'stale'} as of ${context.fetchedAt}.`];
  const hasNumber = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  if (row.nextEarningsDate) notes.push(`Earnings: ${row.nextEarningsDate}.`);
  else notes.push(row.earningsChecked ? 'No earnings returned by the last calendar check.' : 'Upcoming earnings not verified.');
  if (row.corporateActionType) notes.push(`Corporate action: ${row.corporateActionType} ${row.corporateActionDate || ''}.`);
  if (row.recentSecForm) notes.push(`SEC filing: ${row.recentSecForm} ${row.recentSecFiledAt || ''}.`);
  if (hasNumber(row.macroStress)) notes.push(`Macro stress ${Number(row.macroStress).toFixed(0)}/100.`);
  if (fresh) {
    const blackout = Number(settings.earningsBlackoutDays ?? 2);
    if (blackout > 0 && hasNumber(row.daysToEarnings) && row.daysToEarnings >= 0 && row.daysToEarnings <= blackout)
      blockers.push('Known upcoming earnings falls inside the configured blackout.');
    if (
      Number(row.corporateActionRisk) >= 50 &&
      hasNumber(row.daysToCorporateAction) &&
      Math.abs(row.daysToCorporateAction) <= Number(settings.corporateActionBlackoutDays ?? 2)
    )
      blockers.push('Known corporate action falls inside the configured blackout.');
    if (
      Number(row.secFilingRisk) >= 75 &&
      hasNumber(row.secFilingAgeHours) &&
      Number(row.secFilingAgeHours) + Math.max(0, ageMs) / 3600000 <= Number(settings.secFilingBlackoutHours ?? 4)
    )
      blockers.push('Fresh high-impact SEC filing requires review.');
    if (Number(row.macroStress) >= 90) blockers.push('Extreme cached macro stress requires review.');
  }
  return { blockers, notes };
}

export async function fetchInvestmentResearch(symbols, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const fetcher = options.fetcher || fetch;
  const providerMetrics = Array.isArray(options.providerMetrics) ? options.providerMetrics : [];
  const researchOptions = { ...options, fetcher, providerMetrics };
  const requested = [
    ...new Set(symbols.map((s) => String(s).trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.-]{0,10}$/.test(s))),
  ].slice(0, options.maxSymbols || 20);
  const universe = [...new Set(['SPY', ...requested])];
  const results = new Map();
  const errors = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, universe.length) }, async () => {
      while (cursor < universe.length) {
        const symbol = universe[cursor++];
        try {
          const alpacaKeys = options.alpacaKeys || { keyId: config.alpacaKeyId, secretKey: config.alpacaSecretKey };
          if (!alpacaKeys.keyId || !alpacaKeys.secretKey) throw new Error('Alpaca historical-bars credentials are required; unofficial Yahoo Chart access is disabled.');
          const start = new Date(now.getTime() - 5 * 366 * 24 * 60 * 60_000);
          const query = new URLSearchParams({ timeframe: '1Day', start: start.toISOString(), end: now.toISOString(), limit: '10000', adjustment: 'split', feed: config.alpacaDataFeed, sort: 'asc' });
          const rawBars = [];
          let pageToken = '';
          do {
            if (pageToken) query.set('page_token', pageToken);
            const payload = await fetchInvestmentBarsPage(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars?${query}`, {
              accept: 'application/json', 'APCA-API-KEY-ID': alpacaKeys.keyId, 'APCA-API-SECRET-KEY': alpacaKeys.secretKey,
            }, researchOptions, symbol);
            rawBars.push(...payload.bars[symbol]);
            pageToken = payload.next_page_token || '';
          } while (pageToken && rawBars.length < 20_000);
          const timestamps = rawBars.map((bar) => Math.floor(Date.parse(bar.t) / 1000));
          const closes = rawBars.map((bar) => Number(bar.c));
          const result = { timestamp: timestamps, indicators: { quote: [{ open: rawBars.map((bar) => Number(bar.o)), high: rawBars.map((bar) => Number(bar.h)), low: rawBars.map((bar) => Number(bar.l)), close: closes, volume: rawBars.map((bar) => Number(bar.v || 0)) }], adjclose: [{ adjclose: closes }] }, events: {} };
          const bars = completedAdjustedDailyBars(result, now);
          const events = ['splits', 'dividends'].flatMap((kind) =>
            Object.values(result.events?.[kind] || {}).map((e) => ({
              type: kind === 'splits' ? 'split' : 'dividend',
              date: localDateKey(new Date(e.date * 1000), 'America/New_York'),
            })),
          );
          results.set(symbol, { bars, events });
        } catch (error) {
          errors.push({
            symbol,
            error: error.name === 'TimeoutError' ? 'Provider timeout.' : String(error.message).slice(0, 180),
          });
        }
      }
    }),
  );
  const benchmark = results.get('SPY')?.bars || [];
  let rows = requested
    .filter((s) => results.has(s))
    .map((symbol) =>
      analyzeInvestment(symbol, results.get(symbol).bars, benchmark, {
        ...options,
        now,
        events: results.get(symbol).events,
        eventContext: {
          fetchedAt: options.eventSnapshot?.fetchedAt,
          asset: options.eventSnapshot?.assets?.find((row) => row.symbol === symbol),
        },
      }),
    )
    .sort(
      (a, b) =>
        Number(b.decision === 'RESEARCH_CANDIDATE') - Number(a.decision === 'RESEARCH_CANDIDATE') ||
        (b.score ?? -1) - (a.score ?? -1),
    );
  // Fundamental enrichment is opt-in and only runs for rows that will be
  // presented. Automated daily trend journaling remains price-only.
  if (options.includeFundamentals && rows.length) {
    const limit = Math.max(1, Math.min(5, Number(options.fundamentalLimit) || 5));
    const selected = rows.slice(0, limit);
    const fundamentals = await fetchIssuerAnnualFundamentals(selected.map((row) => row.symbol), now, options.metrics, options.secFetcher || fetcher);
    const bySymbol = new Map(fundamentals.map((row) => [row.symbol, row]));
    rows = rows.map((row) => {
      const annualFundamentals = bySymbol.get(row.symbol) || { symbol: row.symbol, status: 'unavailable', reason: 'No SEC fundamentals response was returned.' };
      const postFilingSplit = (row.events || []).some((event) => event.type === 'split' && event.date > (annualFundamentals.filing?.periodEnd || ''));
      const historicalValuations = estimateHistoricalAnnualMultiples(results.get(row.symbol)?.bars,
        annualFundamentals.historicalValuationInputs, row.events, row.asOf);
      return { ...row, annualFundamentals, historicalValuations,
        historicalValuationSummary: summarizeHistoricalAnnualMultiples(historicalValuations),
        annualValuation: estimateAnnualTradingMultiples(row.rawClose, row.asOf, annualFundamentals, { postFilingSplit }) };
    });
  }
  return {
    fetchedAt: now.toISOString(),
    provider: 'Alpaca historical bars',
    adjustment: 'Split-adjusted OHLC; completed sessions only (dividend adjustments/events unavailable)',
    requested,
    benchmark: { symbol: 'SPY', sessions: benchmark.length, asOf: benchmark.at(-1)?.date || '', marketRegime: classifyBenchmarkRegime(benchmark) },
    rows,
    errors,
    providerMetrics,
    ...(options.includeHistory ? { histories: Object.fromEntries(results) } : {}),
    evidence:
      'Current watchlist history is survivorship-biased. Historical analogs are descriptive, not an out-of-sample strategy validation.',
  };
}

export function investmentResearchText(report, count = 5) {
  const number = (v, places = 1) => (Number.isFinite(v) ? v.toFixed(places) : 'unknown');
  const compactMoney = (value, unit = 'USD') => {
    if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return 'unavailable';
    const magnitude = Math.abs(Number(value));
    const suffix = magnitude >= 1e12 ? 'T' : magnitude >= 1e9 ? 'B' : magnitude >= 1e6 ? 'M' : '';
    const scaled = suffix === 'T' ? Number(value) / 1e12 : suffix === 'B' ? Number(value) / 1e9 : suffix === 'M' ? Number(value) / 1e6 : Number(value);
    const currency = unit === 'USD' ? '$' : `${unit} `;
    return `${currency}${scaled.toLocaleString('en-US', { maximumFractionDigits: suffix ? 2 : 0 })}${suffix}`;
  };
  const fundamentalsText = (fundamentals, valuation, historicalValuations = [], historicalValuationSummary = {}) => {
    if (!fundamentals) return '';
    if (fundamentals.status === 'unavailable' || fundamentals.status === 'coverage_limited') return `\nSEC annual fundamentals ${fundamentals.status === 'coverage_limited' ? 'coverage limited' : 'unavailable'}: ${fundamentals.reason || 'no standardized USD facts were available for the selected annual filing.'}\nPrice multiples unavailable: ${valuation?.reason || 'insufficient price/share/annual facts.'}`;
    const metrics = fundamentals.metrics || {};
    const render = (key) => compactMoney(metrics[key]?.value, metrics[key]?.unit || 'USD');
    const renderPct = (key) => Number.isFinite(metrics[key]?.value) ? `${metrics[key].value.toFixed(1)}%` : 'unavailable';
    const renderPctHistory = (key) => (metrics[key]?.history || []).slice(0, 3).reverse()
      .map((row) => `${String(row.periodEnd || '').slice(0, 4)} ${Number(row.value).toFixed(1)}%`).join(' → ') || 'unavailable';
    const renderPp = (key) => Number.isFinite(metrics[key]?.value) ? `${metrics[key].value >= 0 ? '+' : ''}${metrics[key].value.toFixed(1)} pp` : 'unavailable';
    const renderHistory = (key) => (metrics[key]?.history || []).slice(0, 3).reverse()
      .map((row) => `${String(row.periodEnd || '').slice(0, 4)} ${compactMoney(row.value, metrics[key]?.unit || 'USD')}`)
      .join(' → ') || 'unavailable';
    const renderRatio = (key) => Number.isFinite(metrics[key]?.value) ? `${Number(metrics[key].value).toFixed(2)}x` : 'unavailable';
    const renderRatioHistory = (key) => (metrics[key]?.history || []).slice(0, 3).reverse()
      .map((row) => `${String(row.periodEnd || '').slice(0, 4)} ${Number(row.value).toFixed(2)}x`).join(' → ') || 'unavailable';
    const renderBalanceHistory = (key) => (metrics[key]?.history || []).slice(0, 3).reverse()
      .map((row) => `${String(row.periodEnd || '').slice(0, 4)} ${compactMoney(row.value)}`).join(' → ') || 'unavailable';
    const renderShareHistory = (key) => (metrics[key]?.history || []).slice(0, 3).reverse()
      .map((row) => `${String(row.periodEnd || '').slice(0, 4)} ${(Number(row.value) / 1e6).toFixed(1)}M`)
      .join(' → ') || 'unavailable';
    const renderPerShare = (value) => Number.isFinite(Number(value)) ? `$${Number(value).toFixed(2)}` : 'unavailable';
    const renderPerShareHistory = (key) => (metrics[key]?.history || []).slice(0, 3).reverse()
      .map((row) => `${String(row.periodEnd || '').slice(0, 4)} ${renderPerShare(row.value)}`)
      .join(' → ') || 'unavailable';
    const renderAnnualizedGrowth = (key) => {
      const growth = annualizedMetricGrowth(metrics[key]?.history || []);
      return growth ? `${growth.pct >= 0 ? '+' : ''}${growth.pct.toFixed(1)}%/yr (${growth.from.slice(0, 4)}–${growth.through.slice(0, 4)}, ${growth.periods} annual periods)` : 'unavailable (need three positive, consecutive annual periods)';
    };
    const growth = metrics.revenue?.growthPct;
    const debt = [metrics.longTermDebtCurrent?.value, metrics.longTermDebtNoncurrent?.value]
      .map((value) => value !== null && value !== undefined && Number.isFinite(Number(value)) ? compactMoney(value) : 'unavailable');
    const sharesValue = metrics.sharesOutstanding?.value;
    const shares = sharesValue !== null && sharesValue !== undefined && Number.isFinite(Number(sharesValue)) ? `${(Number(sharesValue) / 1e6).toFixed(1)}M` : 'unavailable';
    const dilutedSharesValue = metrics.weightedAverageDilutedShares?.value;
    const dilutedShares = dilutedSharesValue !== null && dilutedSharesValue !== undefined && Number.isFinite(Number(dilutedSharesValue))
      ? `${(Number(dilutedSharesValue) / 1e6).toFixed(1)}M` : 'unavailable';
    const dilutedShareGrowth = metrics.weightedAverageDilutedShares?.growthPct;
    const dilutedEps = metrics.dilutedEps?.value;
    const filed = fundamentals.filing || {};
    const link = filed.url ? ` | [SEC filing](${filed.url})` : '';
    const multiple = (value) => Number.isFinite(value) && value > 0 ? `${value.toFixed(1)}x` : 'unavailable';
    const yieldPct = Number.isFinite(valuation?.freeCashFlowYieldPct) ? `${valuation.freeCashFlowYieldPct.toFixed(2)}%` : 'unavailable';
    const multipleText = valuation?.status === 'estimated'
      ? `\nIndicative backward-looking annual multiples: implied market cap ${compactMoney(valuation.marketCapEstimate)} | P/S ${multiple(valuation.priceToSales)} | P/E ${multiple(valuation.priceToEarnings)} | price/FCF ${multiple(valuation.priceToFreeCashFlow)} | FCF yield ${yieldPct}. Price ${compactMoney(valuation.price)} as of ${valuation.priceAsOf}; shares ${shares} as of ${valuation.shareCountAsOf}; annual facts FY ended ${valuation.annualPeriodEnd}. ${valuation.limitations.join(' ')}`
      : `\nIndicative annual multiples unavailable: ${valuation?.reason || 'price/share/annual facts do not support a reliable estimate.'}`;
    const snapshots = (fundamentals.historicalValuationInputs || []).map((x) => x.filing?.periodEnd).filter(Boolean);
    const history = historicalValuations;
    const summary = historicalValuationSummary;
    const range = (key) => summary[key]?.sampleSize >= 3
      ? `${summary[key].min.toFixed(1)}–${summary[key].max.toFixed(1)}x (n=${summary[key].sampleSize})` : `insufficient observations (n=${summary[key]?.sampleSize || 0})`;
    const historicalText = history.some((row) => row.status === 'estimated')
      ? `\nHistorical 10-K multiples (exact filing facts; first later close; observed, not fair value): ${history.filter((row) => row.status === 'estimated').slice(0, 5).map((row) => `FY${row.fiscalYear} P/S ${multiple(row.priceToSales)} P/E ${multiple(row.priceToEarnings)} P/FCF ${multiple(row.priceToFreeCashFlow)} @${row.priceAsOf}`).join(' | ')}. Sample ranges: P/S ${range('priceToSales')} | P/E ${range('priceToEarnings')} | P/FCF ${range('priceToFreeCashFlow')}.${history.some((row) => row.status === 'unavailable') ? ` ${history.filter((row) => row.status === 'unavailable').length} snapshots withheld for data/split limits.` : ''}`
      : snapshots.length ? '\nHistorical filing-date multiples unavailable: no split-safe, dated post-filing price/share/fundamental snapshots passed the data checks.' : '';
    return `\nSEC annual fundamentals (${filed.form || 'annual filing'}; filed ${filed.filedAt || 'unknown'}; FY end ${filed.periodEnd || 'unknown'}): revenue ${render('revenue')}${Number.isFinite(growth) ? ` (${growth >= 0 ? '+' : ''}${growth.toFixed(1)}% vs prior annual period)` : ''}; gross profit ${render('grossProfit')}; gross/operating/net/FCF margins ${renderPct('grossMarginPct')} / ${renderPct('operatingMarginPct')} / ${renderPct('netMarginPct')} / ${renderPct('freeCashFlowMarginPct')}; net income ${render('netIncome')}; diluted EPS ${renderPerShare(dilutedEps)}; operating income / interest expense ${render('operatingIncome')} / ${render('interestExpense')}; simplified coverage ${renderRatio('interestCoverageRatio')}; operating cash flow ${render('operatingCashFlow')}; OCF/net income ${renderRatio('operatingCashConversion')}; ROE/ROA (net income ÷ average balance) ${renderPct('returnOnEquityPct')} / ${renderPct('returnOnAssetsPct')}; capex ${render('capitalExpenditure')}; calculated FCF ${render('freeCashFlow')}; total assets/equity ${render('totalAssets')} / ${render('stockholdersEquity')}; current assets/liabilities ${render('currentAssets')} / ${render('currentLiabilities')}; working capital ${render('workingCapital')}; current ratio ${renderRatio('currentRatio')}; receivables ${render('accountsReceivable')}; inventory ${render('inventory')}; receivables growth minus revenue growth ${renderPp('receivablesRevenueGrowthGapPp')}; cash ${render('cash')}; current/noncurrent long-term debt ${debt.join(' / ')}; reported principal maturity ladder (next 12 mo / years 2 / 3 / 4 / 5 / after 5) ${['debtMaturityNext12Months', 'debtMaturityYearTwo', 'debtMaturityYearThree', 'debtMaturityYearFour', 'debtMaturityYearFive', 'debtMaturityAfterYearFive'].map(render).join(' / ')}; cash less those debts ${render('cashLessLongTermDebt')}; period-end common shares ${shares}; weighted-average diluted shares ${dilutedShares}${Number.isFinite(dilutedShareGrowth) ? ` (${dilutedShareGrowth >= 0 ? '+' : ''}${dilutedShareGrowth.toFixed(1)}% vs prior annual period)` : ''}.${link}\nAvailable annual trend (oldest → newest): revenue ${renderHistory('revenue')} | gross profit ${renderHistory('grossProfit')} | net income ${renderHistory('netIncome')} | OCF/net income ${renderRatioHistory('operatingCashConversion')} | ROE ${renderPctHistory('returnOnEquityPct')} | ROA ${renderPctHistory('returnOnAssetsPct')} | receivables ${renderBalanceHistory('accountsReceivable')} | inventory ${renderBalanceHistory('inventory')} | diluted EPS ${renderPerShareHistory('dilutedEps')} | FCF ${renderHistory('freeCashFlow')} | weighted-average diluted shares ${renderShareHistory('weightedAverageDilutedShares')}.\nAnnualized growth across available SEC periods: revenue ${renderAnnualizedGrowth('revenue')} | gross profit ${renderAnnualizedGrowth('grossProfit')} | net income ${renderAnnualizedGrowth('netIncome')} | diluted EPS ${renderAnnualizedGrowth('dilutedEps')} | FCF ${renderAnnualizedGrowth('freeCashFlow')}.${multipleText}${historicalText}\nSEC reported facts only. ROE/ROA require aligned positive average balances. Ratios vary by issuer and industry. Current ratio and working capital are descriptive, not standalone solvency conclusions. Receivables/inventory and OCF/net income are descriptive only, not a full accounting-quality test. Weighted-average diluted shares do not by themselves measure issuance, basic-share dilution, or per-share value creation. Diluted EPS and growth are historical, not forecasts. Missing or misaligned facts stay unavailable. No intrinsic/fair-value estimate or buy/hold recommendation is implied.`;
  };
  const lines = report.rows.slice(0, count).map((r) => {
    const h = r.historical;
    return (
      `**${r.symbol} — ${r.decision.replaceAll('_', ' ')}** | ${r.horizon} sessions${r.symbol === 'SPY' ? '' : ` | rank ${number(r.score)}/100`}\n` +
      `Adjusted total-return proxy over 5/20/60 sessions: ${[5, 20, 60].map((h) => `${number(r.absoluteReturns?.[h])}%`).join(' / ')}\n` +
      `Long-horizon adjusted-price context (asset return / SPY excess; historical only): ${(r.longTermPriceContext || []).map((row) => `${row.label} ${row.status === 'observed' ? `${number(row.assetAdjustedReturnPct)}% / ${number(row.excessAdjustedReturnPct)} pp` : 'unavailable'}`).join(' | ') || 'unavailable'}\n` +
      `As of ${r.asOf || 'unknown'} | versus SPY ${number(r.relativeReturns?.[r.horizon])}% | 60-session trend persistence ${number(r.trendPersistence)}% | drawdown ${number(r.drawdownPct)}%\n` +
      (h
        ? `Historical non-overlapping analogs n=${h.samples}: mean net ${number(h.meanNetReturnPct)}%, excess vs SPY ${number(h.meanExcessReturnPct)}%, downside 10th percentile ${number(h.downside10Pct)}%. ${h.enoughExamples ? '' : 'Small sample. '}`
        : r.symbol === 'SPY'
          ? 'Broad-market baseline for comparison; not ranked against itself. '
          : 'Historical analogs unavailable or withheld. ') +
      `\n${r.reasons?.length ? r.reasons.join(' ') : 'Trend, relative strength and liquidity research filters passed.'}` +
      `\n${(r.eventRiskNotes || []).join(' ')}` + fundamentalsText(r.annualFundamentals, r.annualValuation,
        r.historicalValuations, r.historicalValuationSummary)
    );
  });
  if (!lines.length) lines.push('No usable long-horizon research rows.');
  const regime = report.benchmark?.marketRegime;
  if (regime) {
    const volatility = Number.isFinite(regime.annualizedVolatilityPct)
      ? `${regime.volatilityRegime} (${regime.annualizedVolatilityPct.toFixed(1)}% annualized; ${Number.isFinite(regime.volatilityPercentile) ? `${regime.volatilityPercentile.toFixed(0)}th percentile` : 'percentile unavailable'}, ${regime.volatilityWindows} rolling windows)`
      : 'unavailable';
    const drawdown = Number.isFinite(regime.drawdownFrom252ObservationPeakPct) ? `${regime.drawdownFrom252ObservationPeakPct.toFixed(1)}%` : 'unavailable';
    lines.unshift(`SPY benchmark regime: trend ${regime.label} | volatility ${volatility} | drawdown from 252-observation peak ${drawdown} as of ${regime.asOf || 'unknown'} | ${regime.method}`);
  }
  const regimeEvidence = Object.entries(report.forward?.byRegime || {}).flatMap(([label, horizons]) => {
    const rows = INVESTMENT_HORIZONS.flatMap((horizon) => {
      const row = horizons[horizon];
      return row?.nonOverlappingWindows ? [`${horizon}d n=${row.nonOverlappingWindows} mean net ${number(row.meanNetReturnPct)}%`] : [];
    });
    return rows.length ? [`${label}: ${rows.join(', ')}`] : [];
  });
  if (regimeEvidence.length) lines.push(`Frozen forward outcomes by benchmark regime (non-overlapping samples; descriptive, no regime-based score adjustment): ${regimeEvidence.join(' | ')}`);
  const volatilityEvidence = Object.entries(report.forward?.byVolatilityRegime || {}).flatMap(([label, horizons]) => {
    const rows = INVESTMENT_HORIZONS.flatMap((horizon) => {
      const row = horizons[horizon];
      return row?.nonOverlappingWindows ? [`${horizon}s n=${row.nonOverlappingWindows}, net ${number(row.meanNetReturnPct)}%, SPY excess ${number(row.meanExcessReturnPct)}%`] : [];
    });
    return rows.length ? [`${label}: ${rows.join(', ')}`] : [];
  });
  if (volatilityEvidence.length) lines.push(`Frozen forward outcomes by SPY volatility regime (non-overlapping samples; descriptive, no volatility-based score adjustment): ${volatilityEvidence.join(' | ')}`);
  if (report.errors.length) lines.push(`Provider errors: ${report.errors.map((r) => `${r.symbol}: ${r.error}`).join('; ')}`);
  if (Array.isArray(report.providerMetrics) && report.providerMetrics.length) {
    const metrics = report.providerMetrics;
    const latencies = metrics.map((row) => Number(row.latencyMs)).filter(Number.isFinite);
    const utilizations = metrics.map((row) => {
      const limit = Number(row.rateLimit?.limit), remaining = Number(row.rateLimit?.remaining);
      return Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining) ? Math.max(0, Math.min(100, (limit - remaining) / limit * 100)) : null;
    }).filter(Number.isFinite);
    lines.push(`Historical-data provider diagnostics: ${metrics.length} requests | ${metrics.filter((row) => row.retry).length} retries | ${metrics.filter((row) => Number(row.status) >= 400 || Number(row.status) === 0).length} failed attempts | average response ${latencies.length ? `${(latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(0)} ms` : 'unknown'} | peak reported quota use ${utilizations.length ? `${Math.max(...utilizations).toFixed(1)}%` : 'unknown'}.`);
  }
  const disclaimer = 'Daily trend research plus limited filing facts and descriptive annual multiples; no multi-year thesis, intrinsic/fair value, personal portfolio review, or buy instruction. Confirm current shares, filings, accounting and valuation independently.';
  const body = lines.join('\n\n');
  const marker = '\n[Details truncated]';
  const budget = 4000 - disclaimer.length - 2;
  const safeBody = body.length > budget ? `${body.slice(0, budget - marker.length).trimEnd()}${marker}` : body;
  return `${safeBody}\n\n${disclaimer}`;
}
