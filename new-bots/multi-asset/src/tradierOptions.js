import { optionNumber, validOptionDate, tradierUnderlyingSymbol, optionIdentityOccurrences,
  tradierContractIdentity, validateStandardOptionIdentity } from '../../shared/optionContractIdentity.js';
import { parseExpirationInventory, tradierChainRows } from '../../shared/tradierOptionResponses.js';
import { createTradierMarketFetch } from '../../shared/tradierHttp.js';

const SANDBOX_URL = 'https://sandbox.tradier.com/v1';
const PRODUCTION_URL = 'https://api.tradier.com/v1';

function optionalFinite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function quoteTimestamp(option, side) {
  const raw = option?.[`${side}_date`] ?? option?.[`${side}Date`];
  if (raw == null || raw === '') return NaN;
  const n = optionNumber(raw);
  const milliseconds = n !== null ? (n < 1e12 ? n * 1000 : n) : typeof raw === 'string' ? Date.parse(raw) : NaN;
  return Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : NaN;
}

export async function fetchTradierChains(universe, {
  token,
  environment = 'sandbox',
  fetchImpl = fetch,
  now = Date.now(),
  clockNow = Date.now,
  maxAgeMinutes = 25,
  minDaysToExpiry = 7,
  maxDaysToExpiry = 45,
  maxFutureQuoteMs = 5_000,
  maxQuoteSideSkewMs = 3_000,
  timeoutMs = 12_000,
  maxConcurrentUnderlyings = 3,
  providerMetrics = [], startPacer, retrySleep, maxAttempts, maxRetryWaitMs,
} = {}) {
  if (!token) throw new Error('TRADIER_TOKEN is required when OPTIONS_SOURCE=tradier');
  if (!['sandbox', 'production'].includes(environment)) throw new Error('TRADIER_ENV must be sandbox or production');
  if (!Array.isArray(universe)) throw new Error('Options universe must be a JSON array');
  if (!Number.isInteger(maxConcurrentUnderlyings) || maxConcurrentUnderlyings < 1 || maxConcurrentUnderlyings > 4) {
    throw new RangeError('maxConcurrentUnderlyings must be an integer from 1 to 4.');
  }
  if (!Number.isFinite(maxFutureQuoteMs) || maxFutureQuoteMs < 0 || maxFutureQuoteMs > 30_000) {
    throw new RangeError('maxFutureQuoteMs must be between 0 and 30000.');
  }
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) throw new RangeError('Invalid quote age or scan timestamp.');
  if (!Number.isFinite(maxQuoteSideSkewMs) || maxQuoteSideSkewMs < 0 || maxQuoteSideSkewMs > 3_000) throw new RangeError('maxQuoteSideSkewMs must be between 0 and 3000.');
  const baseUrl = environment === 'production' ? PRODUCTION_URL : SANDBOX_URL;
  fetchImpl = createTradierMarketFetch({ fetchImpl, token, environment, providerMetrics, clockNow,
    ...(startPacer ? { startPacer } : {}), ...(retrySleep ? { retrySleep } : {}),
    ...(maxAttempts != null ? { maxAttempts } : {}), ...(maxRetryWaitMs != null ? { maxRetryWaitMs } : {}) });
  const rows = universe.slice(0, 12);
  const output = new Array(rows.length);
  const startedAt = clockNow(), initialNow = now;
  const observedNow = () => initialNow + Math.max(0, clockNow() - startedAt);

  const fetchOne = async (item, index) => {
    const symbol = String(item?.symbol ?? '').trim().toUpperCase();
    const providerSymbol = tradierUnderlyingSymbol(symbol);
    const expiry = String(item?.expiry ?? '').trim();
    const automaticExpiry = expiry.toLowerCase() === 'auto';
    if (!providerSymbol || (!automaticExpiry && !validOptionDate(expiry))) {
      output[index] = { symbol: symbol || null, expiry: expiry || null, status: 'invalid-universe-row' };
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      let selectedExpiry = expiry;
      if (automaticExpiry) {
        const expiryUrl = new URL(`${baseUrl}/markets/options/expirations`);
        expiryUrl.searchParams.set('symbol', providerSymbol);
        const expiryResponse = await fetchImpl(expiryUrl, { headers, signal: controller.signal });
        if (!expiryResponse.ok) {
          output[index] = { symbol, expiry: null, status: 'expiration-provider-error', httpStatus: expiryResponse.status };
          return;
        }
        const expirationDates = parseExpirationInventory(await expiryResponse.json()).dates;
        const minDays = Math.max(0, Number(minDaysToExpiry) || 0);
        const maxDays = Math.max(minDays, Number(maxDaysToExpiry) || minDays);
        selectedExpiry = expirationDates.map(String).sort()
          .find((date) => {
            const days = (Date.parse(`${date}T23:59:59Z`) - observedNow()) / 86_400_000;
            return days >= minDays && days <= maxDays;
          });
        if (!selectedExpiry) {
          output[index] = { symbol, expiry: null, status: 'no-expiration-in-configured-window', minDaysToExpiry: minDays, maxDaysToExpiry: maxDays };
          return;
        }
      }
      const url = new URL(`${baseUrl}/markets/options/chains`);
      url.searchParams.set('symbol', providerSymbol);
      url.searchParams.set('expiration', selectedExpiry);
      url.searchParams.set('greeks', 'true');
      const response = await fetchImpl(url, { headers, signal: controller.signal });
      if (!response.ok) {
        output[index] = { symbol, expiry: selectedExpiry, status: 'provider-error', httpStatus: response.status };
        return;
      }
      const body = await response.json();
      const quoteObservedAt = observedNow();
      const rawOptions = tradierChainRows(body);
      const occurrences = optionIdentityOccurrences(rawOptions);
      const options = rawOptions.map((option) => {
        const identity = tradierContractIdentity(option, { underlying: symbol, expiry: selectedExpiry, occurrences });
        const bid = optionNumber(option?.bid), ask = optionNumber(option?.ask), strike = identity.strike;
        option = option && typeof option === 'object' ? option : {};
        const bidAt = quoteTimestamp(option, 'bid'), askAt = quoteTimestamp(option, 'ask');
        const quoteAgeMinutes = Math.max((quoteObservedAt - Math.min(bidAt, askAt)) / 60_000, 0);
        const oi = optionNumber(option.open_interest ?? option.openInterest);
        const volume = optionNumber(option.volume);
        const greekUpdatedAt = Date.parse(option.greeks?.updated_at ?? option.greeks?.updatedAt ?? '');
        const greekAgeMs = Number.isFinite(greekUpdatedAt) ? Math.max(0, quoteObservedAt - greekUpdatedAt) : null;
        const greeks = option.greeks && typeof option.greeks === 'object' ? {
          delta: optionalFinite(option.greeks.delta), gamma: optionalFinite(option.greeks.gamma),
          theta: optionalFinite(option.greeks.theta), vega: optionalFinite(option.greeks.vega),
          rho: optionalFinite(option.greeks.rho), bidIv: optionalFinite(option.greeks.bid_iv),
          midIv: optionalFinite(option.greeks.mid_iv), askIv: optionalFinite(option.greeks.ask_iv),
          updatedAt: Number.isFinite(greekUpdatedAt) ? new Date(greekUpdatedAt).toISOString() : null,
          ageMs: greekAgeMs,
          freshness: greekAgeMs === null ? 'timestamp_unavailable' : greekAgeMs <= 2 * 60 * 60_000 ? 'within_two_hours' : 'older_than_two_hours',
        } : null;
        const quoteValid = strike != null && Number.isFinite(bid) && Number.isFinite(ask)
          && bid >= 0 && ask > 0 && ask >= bid
          && Number.isFinite(bidAt) && Number.isFinite(askAt)
          && bidAt <= quoteObservedAt + maxFutureQuoteMs && askAt <= quoteObservedAt + maxFutureQuoteMs
          && quoteAgeMinutes <= maxAgeMinutes;
        const sideSkewValid = Math.abs(bidAt - askAt) <= maxQuoteSideSkewMs;
        const valid = identity.valid && quoteValid && sideSkewValid;
        const rejectionReasons = [...identity.reasons, ...(!quoteValid ? ['quote_missing_crossed_stale_or_future'] : []),
          ...(Number.isFinite(bidAt) && Number.isFinite(askAt) && !sideSkewValid ? ['quote_side_time_skew'] : [])];
        return {
          symbol: identity.symbol, underlying: identity.underlying, expiry: identity.expiry,
          type: identity.type, strike, root: identity.root,
          bid, ask, bidAt: Number.isFinite(bidAt) ? new Date(bidAt).toISOString() : null,
          askAt: Number.isFinite(askAt) ? new Date(askAt).toISOString() : null,
          quoteAgeMinutes: Number.isFinite(quoteAgeMinutes) ? Number(quoteAgeMinutes.toFixed(1)) : null,
          openInterest: Number.isInteger(oi) && oi >= 0 ? oi : null, volume: Number.isInteger(volume) && volume >= 0 ? volume : null,
          multiplier: identity.multiplier, identityStatus: identity.status, identityReasons: identity.reasons,
          delta: greeks?.delta ?? null,
          impliedVolatility: greeks?.midIv ?? null,
          greeks,
          quoteValid: valid,
          rejectionReasons, invalidReason: valid ? null : rejectionReasons.join('; '),
        };
      });
      const rejectionReasons = {};
      for (const leg of options) for (const reason of leg.rejectionReasons) rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
      output[index] = { symbol, expiry: selectedExpiry, status: rawOptions.length ? 'chain-loaded' : 'empty-chain', source: `Tradier ${environment}`, retrievedAt: new Date(quoteObservedAt).toISOString(), options,
        identityDiagnostics: { contractsReturned: options.length, verifiedIdentities: options.filter((leg) => leg.identityStatus === 'verified_standard_contract').length,
          identityRejected: options.filter((leg) => leg.identityStatus !== 'verified_standard_contract').length, validQuotes: options.filter((leg) => leg.quoteValid).length, rejectionReasons } };
    } catch (error) {
      output[index] = { symbol, expiry: automaticExpiry ? null : expiry, status: error?.name === 'AbortError' ? 'provider-timeout' : 'provider-error', errorCode: error?.code ?? null,
        error: error?.name === 'AbortError' ? 'Request timed out' : String(error?.message ?? error) };
    } finally {
      clearTimeout(timeout);
    }
  };
  let cursor = 0;
  const workerCount = Math.min(maxConcurrentUnderlyings, rows.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < rows.length) {
      const index = cursor++;
      await fetchOne(rows[index], index);
    }
  }));
  return output;
}

export function buildDirectionalDebitSpread(underlying, chain, { minOpenInterest = 100, maxLegSpreadPct = 35, maxCandidates = 4 } = {}) {
  const shortBias = underlying?.scenarios?.find((x) => x.horizon === '1-day')?.bias;
  const longBias = underlying?.scenarios?.find((x) => x.horizon === '5-day')?.bias;
  const direction = shortBias === 'UPWARD WATCH' && longBias === 'UPWARD WATCH' ? 'bullish'
    : shortBias === 'DOWNWARD WATCH' && longBias === 'DOWNWARD WATCH' ? 'bearish' : null;
  if (!direction || underlying?.stale || !Number.isFinite(Number(underlying?.price))) return [];
  const target = Number(underlying.scenarios.find((x) => x.horizon === '1-day')?.target1Scenario);
  if (!(target > 0)) return [];
  const expiry = chain.expiry;
  const optionType = direction === 'bullish' ? 'call' : 'put';
  const occurrences = optionIdentityOccurrences(chain.options ?? []);
  const legs = (chain.options ?? []).filter((x) => x.quoteValid && x.type === optionType
    && validateStandardOptionIdentity(x, { underlying: underlying.symbol, expiry, occurrences }).valid
    && Number(x.openInterest) >= minOpenInterest && Number(x.ask) > 0
    && (x.ask - x.bid) / ((x.ask + x.bid) / 2) * 100 <= maxLegSpreadPct);
  const longs = legs.filter((x) => direction === 'bullish' ? x.strike < target : x.strike > target);
  const candidates = [];
  for (const long of longs) for (const short of legs) {
    const validOrder = direction === 'bullish' ? long.strike < short.strike : long.strike > short.strike;
    if (!validOrder || short.strike === long.strike || short.expiry !== long.expiry) continue;
    const width = Math.abs(short.strike - long.strike);
    const debit = Number(long.ask) - Number(short.bid);
    if (!(debit > 0 && debit < width)) continue;
    if (long.multiplier !== short.multiplier) continue;
    const multiplier = Number(long.multiplier);
    const intrinsicAtTarget = direction === 'bullish'
      ? Math.max(0, target - long.strike) - Math.max(0, target - short.strike)
      : Math.max(0, long.strike - target) - Math.max(0, short.strike - target);
    const maxLossUsd = debit * multiplier;
    const targetPnlUsd = (intrinsicAtTarget - debit) * multiplier;
    const maxProfitUsd = (width - debit) * multiplier;
    const breakeven = direction === 'bullish' ? long.strike + debit : long.strike - debit;
    if (!(targetPnlUsd > 0)) continue;
    candidates.push({
      symbol: underlying.symbol, direction, strategy: direction === 'bullish' ? 'bull-call-debit' : 'bear-put-debit',
      expiry, longLeg: { symbol: long.symbol, strike: long.strike, entry: long.ask, quoteAgeMinutes: long.quoteAgeMinutes },
      shortLeg: { symbol: short.symbol, strike: short.strike, entry: short.bid, quoteAgeMinutes: short.quoteAgeMinutes },
      underlyingReference: Number(underlying.price), underlying1dScenarioTarget: target,
      estimatedNetDebitPerShare: Number(debit.toFixed(4)), multiplier,
      maxLossUsd: Number(maxLossUsd.toFixed(2)), maxProfitAtExpiryUsd: Number(maxProfitUsd.toFixed(2)),
      breakevenAtExpiry: Number(breakeven.toFixed(4)), estimatedExpiryPnlAtScenarioTargetUsd: Number(targetPnlUsd.toFixed(2)),
      openInterest: { long: long.openInterest, short: short.openInterest },
      impliedVolatility: { long: long.impliedVolatility, short: short.impliedVolatility },
      status: 'research-candidate', source: chain.source,
      note: 'Delayed or broker-quoted leg prices; expiry payoff at a heuristic underlying scenario only. Excludes fees, slippage beyond displayed legs, early assignment, volatility/time decay before expiry, and fills. Not an order or recommendation.',
    });
  }
  return candidates.sort((a, b) => b.estimatedExpiryPnlAtScenarioTargetUsd / b.maxLossUsd - a.estimatedExpiryPnlAtScenarioTargetUsd / a.maxLossUsd).slice(0, maxCandidates);
}

export function buildOptionCandidatesForChains(chains, observations, options = {}) {
  const underlyings = new Map((observations ?? [])
    .filter((row) => !row.stale && row.symbol)
    .map((row) => [String(row.symbol).toUpperCase(), row]));
  return (chains ?? []).flatMap((chain) => {
    if (chain.status !== 'chain-loaded') return [];
    const underlying = underlyings.get(String(chain.symbol ?? '').toUpperCase());
    if (!underlying) return [];
    const maxSkew = Number(options.maxUnderlyingQuoteSkewMinutes);
    if (Number.isFinite(maxSkew) && maxSkew > 0 && underlying.observedAt) {
      const underlyingTime = Date.parse(underlying.observedAt);
      if (!Number.isFinite(underlyingTime)) return [];
      const alignedOptions = (chain.options ?? []).filter((leg) => {
        const bidAt = Date.parse(leg.bidAt), askAt = Date.parse(leg.askAt);
        return Number.isFinite(bidAt) && Number.isFinite(askAt)
          && Math.abs(bidAt - underlyingTime) <= maxSkew * 60_000
          && Math.abs(askAt - underlyingTime) <= maxSkew * 60_000;
      });
      if (alignedOptions.length === 0) return [];
      chain = { ...chain, options: alignedOptions };
    }
    return buildDirectionalDebitSpread(underlying, chain, options);
  });
}
