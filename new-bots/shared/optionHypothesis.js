import { tradierUnderlyingSymbol } from './optionContractIdentity.js';

export const OPTION_HYPOTHESIS_VERSION = 'option-primary-hypothesis-v1';
export const OPTIONS_DAY_STRATEGY_ID = 'underlying-confirmed-debit-vertical-v3';
const time = value => typeof value === 'number' && Number.isFinite(value) ? new Date(value).getTime()
  : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
const number = value => typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : NaN;
const sameOptionalTime = (a, b) => a == null && b == null || Number.isFinite(time(a)) && time(a) === time(b);
const sameOptionalNumber = (a, b) => a == null && b == null || Number.isFinite(number(a)) && number(a) === number(b);

/** Snapshot the source before replacing its current-price fields with native quotes. */
export function captureOptionHypothesis(signal, primarySignalObservedAt) {
  if (signal?.primaryHypothesis != null) return structuredClone(signal.primaryHypothesis);
  return {
    version: OPTION_HYPOTHESIS_VERSION,
    underlyingSymbol: signal?.underlyingSymbol, direction: signal?.direction, sessionDate: signal?.sessionDate,
    observedAt: primarySignalObservedAt ?? signal?.observedAt,
    entryPrice: signal?.underlyingPrice, targetPrice: signal?.underlyingTarget, stopPrice: signal?.underlyingStop ?? null,
    entryLow: signal?.entryLow ?? null, entryHigh: signal?.entryHigh ?? null,
    entryExpiresAt: signal?.entryExpiresAt ?? null, forceExitAt: signal?.forceExitAt ?? null,
    signalId: signal?.primarySignalId ?? signal?.signalId ?? null, owner: signal?.primarySignalOwner ?? null,
  };
}

/** Quote refresh never renews source lifetime or changes its absolute target/entry zone. */
export function assessOptionHypothesis({ signal, primarySignalObservedAt, now, maxAgeMs = 120000, forceExitAt = Infinity }) {
  const hypothesis = captureOptionHypothesis(signal, primarySignalObservedAt);
  const reject = reason => ({ valid: false, reason, hypothesis });
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 120000 || !Number.isFinite(now)) return reject('invalid_primary_signal_age_config');
  if (!Number.isFinite(forceExitAt) && forceExitAt !== Infinity) return reject('invalid_primary_lifetime');
  if (!hypothesis || typeof hypothesis !== 'object' || Array.isArray(hypothesis)
    || hypothesis.version !== OPTION_HYPOTHESIS_VERSION) return reject('invalid_primary_hypothesis');
  const symbol = tradierUnderlyingSymbol(hypothesis.underlyingSymbol);
  const origin = time(hypothesis.observedAt), entry = number(hypothesis.entryPrice), target = number(hypothesis.targetPrice);
  if (!symbol || symbol !== tradierUnderlyingSymbol(signal?.underlyingSymbol)
    || !['long', 'short'].includes(hypothesis.direction) || hypothesis.direction !== signal?.direction
    || hypothesis.sessionDate !== signal?.sessionDate || !Number.isFinite(origin) || origin > now + 5000
    || !(entry > 0 && Number.isFinite(entry) && target > 0 && Number.isFinite(target))) return reject('invalid_primary_hypothesis');
  if (hypothesis.direction === 'long' ? target <= entry : target >= entry) return reject('underlying_target_conflicts_with_signal');
  if (hypothesis.stopPrice != null && (!(number(hypothesis.stopPrice) > 0 && Number.isFinite(number(hypothesis.stopPrice)))
    || (hypothesis.direction === 'long' ? number(hypothesis.stopPrice) >= entry : number(hypothesis.stopPrice) <= entry)))
    return reject('invalid_primary_stop');
  if (primarySignalObservedAt != null && time(primarySignalObservedAt) !== origin
    || number(signal?.underlyingTarget) !== target
    || !sameOptionalNumber(hypothesis.stopPrice, signal?.underlyingStop)
    || !sameOptionalNumber(hypothesis.entryLow, signal?.entryLow)
    || !sameOptionalNumber(hypothesis.entryHigh, signal?.entryHigh)
    || !sameOptionalTime(hypothesis.entryExpiresAt, signal?.entryExpiresAt)
    || !sameOptionalTime(hypothesis.forceExitAt, signal?.forceExitAt)) return reject('primary_hypothesis_conflict');
  const low = hypothesis.entryLow == null ? -Infinity : number(hypothesis.entryLow);
  const high = hypothesis.entryHigh == null ? Infinity : number(hypothesis.entryHigh);
  if (Number.isNaN(low) || Number.isNaN(high) || low !== -Infinity && !(low > 0 && Number.isFinite(low))
    || high !== Infinity && !(high > 0 && Number.isFinite(high)) || low > high) return reject('invalid_primary_entry_zone');
  const sourceEntryExpiry = hypothesis.entryExpiresAt == null ? Infinity : time(hypothesis.entryExpiresAt);
  const sourceExit = hypothesis.forceExitAt == null ? Infinity : time(hypothesis.forceExitAt);
  if (Number.isNaN(sourceEntryExpiry) || Number.isNaN(sourceExit)
    || sourceEntryExpiry <= origin || sourceExit <= origin || sourceEntryExpiry < Infinity && sourceEntryExpiry > sourceExit)
    return reject('invalid_primary_lifetime');
  const exit = Math.min(forceExitAt, sourceExit);
  const expiry = Math.min(origin + maxAgeMs, sourceEntryExpiry, exit);
  if (now >= expiry) return reject('primary_signal_expired');
  const currentPrice = number(signal?.underlyingPrice);
  if (!(currentPrice >= low && currentPrice <= high)) return reject('quote_outside_primary_entry_zone');
  return { valid: true, hypothesis: { ...hypothesis, underlyingSymbol: symbol, entryPrice: entry, targetPrice: target,
    observedAt: new Date(origin).toISOString() }, entryExpiresAt: new Date(expiry).toISOString(), forceExitAt: exit };
}
