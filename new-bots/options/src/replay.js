import { replayChronologicalPaper } from '../../shared/chronologicalReplay.js';
import { replayWithShadowConfigs } from '../../shared/shadowReplay.js';
import { buildOptionDayTradeCandidate } from './strategies.js';
import { OPTIONS_DAY_STRATEGY_ID } from './primaryHypothesis.js';
import { OPTION_ENTRY_EVIDENCE_VERSION } from '../../shared/optionEntryEvidence.js';
import { marketDateAt } from '../../shared/marketDate.js';
import { OPTION_IDENTITY_VERSION, optionNumber, parseOccSymbol, tradierUnderlyingSymbol, optionIdentityOccurrences,
  validateStandardOptionIdentity } from '../../shared/optionContractIdentity.js';

export { OPTIONS_DAY_STRATEGY_ID };
const samePrice = (left, right) => Math.abs(Number(left) - Number(right)) < 1e-8;

// Validate every later mark as well as entries. A caller-supplied composite must
// never fill/close an existing paper order using unrelated or unverified legs.
function validateObservation(observation, underlying, legs, policy) {
  const chain = observation?.context?.chain, quote = observation?.quote;
  const rows = Array.isArray(chain?.options) ? chain.options : [];
  const occurrences = optionIdentityOccurrences(rows);
  const selected = legs.map((symbol) => rows.find((row) => parseOccSymbol(row?.symbol)?.canonical === symbol));
  const reasons = selected.flatMap((row) => validateStandardOptionIdentity(row,
    { underlying, expiry: parseOccSymbol(legs[0]).expiry, occurrences }).reasons);
  if (chain?.expiry !== parseOccSymbol(legs[0]).expiry) reasons.push('expiration_identity_mismatch');
  if (chain?.quoteQuality !== 'executable' || selected.some((row) => row?.quoteQuality !== 'executable')) reasons.push('option_quotes_not_executable');
  const at = Date.parse(observation?.asOf), times = selected.map((row) => Date.parse(row?.time));
  if (Number.isFinite(at) && parseOccSymbol(legs[0]).expiry < marketDateAt(at, 'America/New_York')) reasons.push('option_contract_past_expiry');
  const maxAgeMs = Math.min(10000, optionNumber(policy.maxQuoteAgeMs) ?? 10000);
  if (!times.every((time) => Number.isFinite(time) && time <= at && at - time <= maxAgeMs)
    || Math.max(...times) - Math.min(...times) > 3000) reasons.push('option_mark_quote_time_invalid');
  const prices = selected.flatMap((row) => [optionNumber(row?.bid), optionNumber(row?.ask)]);
  if (!prices.every(Number.isFinite) || prices.some((n) => n < 0) || prices[1] < prices[0] || prices[3] < prices[2]) reasons.push('invalid_option_leg_bid_ask');
  const bid = Number(Math.max(0, prices[0] - prices[3]).toFixed(4));
  const ask = Number((prices[1] - prices[2]).toFixed(4));
  if (ask < bid || optionNumber(quote?.bid) === null || optionNumber(quote?.ask) === null
    || !samePrice(bid, quote?.bid) || !samePrice(ask, quote?.ask) || Date.parse(quote?.time) !== Math.min(...times)) reasons.push('option_composite_quote_mismatch');
  return [...new Set(reasons)];
}

/** Replay one fixed debit vertical using point-in-time underlying signals and synchronized option-chain snapshots. */
export async function replayOptionDebitVertical({ underlyingSymbol, spreadSymbols, observations,
  accountEquityUsd, policy = {}, config = {}, scoreFrom = null, shadowConfigs = [], executionCostSchedule }) {
  const underlying = tradierUnderlyingSymbol(underlyingSymbol)?.replaceAll('/', '.');
  const parsed = Array.isArray(spreadSymbols) ? spreadSymbols.map(parseOccSymbol) : [];
  const legs = parsed.map((row) => row?.canonical);
  if (!underlying || legs.length !== 2 || !legs.every(Boolean) || legs[0] === legs[1]
    || parsed.some((row) => row.root !== underlying) || parsed[0].expiry !== parsed[1].expiry || parsed[0].type !== parsed[1].type
    || !(parsed[0].type === 'call' ? parsed[0].strike < parsed[1].strike : parsed[0].strike > parsed[1].strike)) {
    throw new Error('Replay requires an underlying and the ordered long/short option symbols for one vertical.');
  }
  const instrumentKey = `${legs[0]}+${legs[1]}`;
  if (!Array.isArray(observations)) throw new TypeError('Option replay observations must be an array.');
  const validation = { version: OPTION_IDENTITY_VERSION, observationsChecked: observations.length, rejected: 0, rejectionReasons: {} };
  const validatedObservations = observations.map((observation) => {
    const reasons = validateObservation(observation, underlying, legs, policy);
    if (reasons.length) validation.rejected++;
    for (const reason of reasons) validation.rejectionReasons[reason] = (validation.rejectionReasons[reason] || 0) + 1;
    const signal = observation.context?.signal, chain = observation.context?.chain;
    const catalystSource = config.catalystSource ?? 'manual';
    const entryEvidence = { version: OPTION_ENTRY_EVIDENCE_VERSION, sessionDate: signal?.sessionDate, sessionClose: signal?.sessionClose,
      underlyingQuote: signal?.underlyingQuote, legs: Array.isArray(chain?.options) ? chain.options.filter(leg => legs.includes(leg?.symbol)) : [],
      catalyst: observation.context?.entryCatalyst ?? (catalystSource === 'manual'
        ? { source: 'manual', checkedAt: observation.asOf, review: signal?.catalystReview } : null) };
    return { ...observation, quote: { ...observation.quote, optionEntryEvidence: entryEvidence, ...(reasons.length ? { quality: 'unusable' } : {}) },
      context: { ...observation.context, optionQuoteValidationReasons: reasons } };
  });
  const evaluateForConfig = (strategyConfig) => ({ asOf, quote, context, executionCosts }) => {
    if (context.optionQuoteValidationReasons.length) return { status: 'no-setup', reasons: context.optionQuoteValidationReasons };
    const chain = context?.chain;
    if (!chain || !Array.isArray(chain.options)) return { status: 'no-setup', reasons: ['option_chain_unavailable'] };
    const selected = chain.options.filter((leg) => legs.includes(parseOccSymbol(leg?.symbol)?.canonical));
    if (selected.length !== 2 || new Set(selected.map((leg) => String(leg.symbol).toUpperCase())).size !== 2) {
      return { status: 'no-setup', reasons: ['specified_vertical_legs_missing'] };
    }
    const signal = context?.signal;
    if (!signal || tradierUnderlyingSymbol(signal.underlyingSymbol)?.replaceAll('/', '.') !== underlying) {
      return { status: 'no-setup', reasons: ['underlying_signal_mismatch'] };
    }
    const result = buildOptionDayTradeCandidate({ signal, primarySignalObservedAt: context.primarySignalObservedAt,
      chain: { ...chain, options: selected }, now: Date.parse(asOf), config: executionCosts ? { ...strategyConfig,
      feePerContractRoundTrip: executionCosts.roundTripFeesPerUnit / 2,
      slippageReservePerContract: executionCosts.slippageReservePerUnit / 2 } : strategyConfig });
    if (result.status === 'candidate' && result.candidate.instrumentKey !== instrumentKey) {
      return { status: 'no-setup', reasons: ['selected_vertical_identity_mismatch'] };
    }
    // The common paper replay validates this composite quote against the strategy candidate.
    if (result.status === 'candidate' && (!samePrice(result.candidate.bid, quote.bid)
      || !samePrice(result.candidate.ask, quote.ask)
      || Date.parse(result.candidate.quoteTime) !== Date.parse(quote.time))) {
      return { status: 'no-setup', reasons: ['option_composite_quote_mismatch'] };
    }
    return result;
  };
  const baseOptions = { owner: 'options', assetClass: 'option', instrumentKey,
    exposureKey: underlying, strategyId: OPTIONS_DAY_STRATEGY_ID, observations: validatedObservations, bars: [],
    scoreFrom, accountEquityUsd, policy, executionCostSchedule };
  const report = !shadowConfigs.length ? await replayChronologicalPaper({ ...baseOptions, evaluate: evaluateForConfig(config) })
    : await replayWithShadowConfigs({ baseOptions, baseConfig: config, shadowConfigs,
      allowedOverrides: ['minOpenInterest', 'minVolume', 'maxLegSpreadPct', 'minRewardRisk', 'requireCompleteGreeks'], evaluateForConfig });
  return { ...report, optionQuoteValidation: validation };
}
