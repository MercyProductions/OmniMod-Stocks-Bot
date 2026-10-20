import { createHash } from 'node:crypto';
import { marketCloseTime, marketSession } from './time.js';

export const FORECAST_HORIZONS = Object.freeze([5, 15, 30, 90, 240, 'next_session']);
export const PREDICTIVE_SCHEMA = 'stocks-predictive-v1';
const numeric = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const FIELDS = Object.freeze(['relativeVolume', 'change1h', 'changeDay', 'change5d', 'change20d',
  'rsi14', 'dailyRsi14', 'macdHistogramBps', 'vwapDistancePct', 'adx14', 'dailyAtrPercent',
  'intradayAtrPercent', 'relativeStrengthDay', 'sectorRelativeStrength', 'marketMove',
  'marketBreadth', 'spreadBps', 'quoteImbalance', 'tradeFlow1m', 'tradeFlow5m',
  'spreadAcceleration', 'quoteAgeSeconds', 'tradeAgeSeconds', 'dataQuality']);

/** An observation is not an approved forecast. Receipt time must not masquerade as source time. */
export function buildPredictiveObservation(asset, { snapshotId, guildId = '', availableAt = new Date(), scanStartedAt = availableAt } = {}) {
  const received = availableAt instanceof Date ? availableAt : new Date(availableAt);
  const observedMs = Date.parse(asset.livePriceUpdatedAt || asset.lastUpdated);
  const ageSeconds = Number.isFinite(observedMs) ? (received.getTime() - observedMs) / 1000 : null;
  const session = marketSession(received);
  const features = Object.fromEntries(FIELDS.map((key) => [key, numeric(asset[key])]));
  features.macdHistogramBps = numeric(asset.macdHistogram) !== null && asset.price > 0
    ? asset.macdHistogram / asset.price * 10000 : null;
  // Legacy consensus adapters use zero when no microstructure observation exists.
  // Keep those defaults out of the new learner rather than treating absent flow as measured neutrality.
  if (numeric(asset.quoteAgeSeconds) === null) {
    for (const key of ['spreadBps', 'quoteImbalance', 'spreadAcceleration']) features[key] = null;
  }
  if (numeric(asset.tradeAgeSeconds) === null) {
    for (const key of ['tradeFlow1m', 'tradeFlow5m']) features[key] = null;
  }
  const price = numeric(asset.livePrice ?? asset.price);
  const dataIssues = [];
  const featureAge = (received.getTime() - Date.parse(asset.lastUpdated)) / 1000;
  if (!Number.isFinite(featureAge) || featureAge < -5 || featureAge > (numeric(asset.barIntervalMinutes) || 5) * 60 + 90)
    dataIssues.push('feature_timestamp_invalid_or_stale');
  if (ageSeconds === null) dataIssues.push('source_timestamp_missing');
  else if (ageSeconds < -5) dataIssues.push('future_source_timestamp');
  else if (ageSeconds > 120) dataIssues.push('source_stale');
  if (!(price > 0)) dataIssues.push('invalid_price');
  if (asset.halted) dataIssues.push('halted');
  if (asset.delayed) dataIssues.push('delayed_source');
  if (features.dataQuality === null || features.dataQuality < 60) dataIssues.push('insufficient_data_quality');
  const sourceEvents = (asset.manualCatalysts || []).filter((event) => {
    const published = Date.parse(event.publishedAt || event.availableAt || '');
    return Number.isFinite(published) && published <= received.getTime();
  }).map((event) => ({ id: event.id, publishedAt: event.publishedAt || event.availableAt, eventType: event.eventType }));
  const close = marketCloseTime(received);
  const requests = FORECAST_HORIZONS.map((horizon) => {
    // No truncating 240-minute targets into short late-session targets; no guessing next-session calendars.
    const expires = horizon === 'next_session' ? null : new Date(received.getTime() + horizon * 60000);
    const blocked = horizon === 'next_session' ? 'verified_next_session_calendar_required'
      : session.state !== 'regular' ? 'regular_session_training_only'
        : expires > close ? 'horizon_crosses_session_close' : dataIssues[0] || null;
    return { horizon, expiresAt: expires?.toISOString() ?? null, status: blocked ? 'abstain' : 'research_pending', reason: blocked };
  });
  const evidence = [];
  if (features.relativeVolume >= 1.5) evidence.push('elevated_relative_volume');
  if (features.tradeFlow1m > 0.2 && features.tradeFlow5m > 0) evidence.push('positive_classified_trade_flow');
  if (features.relativeStrengthDay > 0 && Math.abs(features.vwapDistancePct ?? Infinity) <= 0.5) evidence.push('relative_strength_near_vwap');
  const id = snapshotId || createHash('sha256').update(JSON.stringify([guildId, asset.symbol, received.toISOString()])).digest('hex');
  return { schema: PREDICTIVE_SCHEMA, id, guildId, symbol: asset.symbol,
    availableAt: received.toISOString(), scanStartedAt: new Date(scanStartedAt).toISOString(),
    sourceAt: Number.isFinite(observedMs) ? new Date(observedMs).toISOString() : null,
    featureSourceAt: asset.lastUpdated || null,
    sourceAgeSeconds: ageSeconds, provider: asset.provider || 'unknown',
    feedCoverage: /iex/i.test(asset.provider || '') ? 'single_venue' : 'unverified',
    price, features, missingFeatures: FIELDS.filter((key) => features[key] === null),
    session: session.state, sessionCloseAt: close.toISOString(), marketRegime: asset.marketRegime || 'unknown',
    catalysts: sourceEvents, dataIssues, requests,
    alertStage: !dataIssues.length && evidence.length >= 2 ? 'EARLY_WATCH' : 'OBSERVATION',
    evidence, movementBeforeObservationPct: features.changeDay,
    earlyPredictionProven: false, productionApproval: false };
}
