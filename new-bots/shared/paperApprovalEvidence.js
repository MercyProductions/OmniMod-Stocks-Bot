import { hasExplicitFiniteAmount } from './strategyConfig.js';

const finite = (value) => hasExplicitFiniteAmount(value) && Math.abs(Number(value)) <= 1_000_000
  ? Number(value) : null;
const GATE = /^[a-z][a-z0-9_]{2,63}$/;

function normalizeMarketGateTrace(candidate, reservedAt) {
  const trace = candidate?.marketGateTrace;
  if (trace == null) return { status: 'unavailable', passedGates: [] };
  const observed = Date.parse(trace?.observedAt ?? '');
  const quote = Date.parse(candidate?.quoteTime ?? '');
  const reserved = Date.parse(reservedAt ?? '');
  const gates = trace?.passedGates;
  if (trace?.source !== 'market_candidate_emission' || trace?.owner !== candidate.owner
    || trace?.strategyId !== candidate.strategyId || !Array.isArray(gates)
    || gates.length < 1 || gates.length > 16 || gates.some((gate) => typeof gate !== 'string' || !GATE.test(gate))
    || new Set(gates).size !== gates.length || !Number.isFinite(observed) || !Number.isFinite(quote)
    || !Number.isFinite(reserved) || Math.abs(observed - quote) > 5_000 || observed > reserved + 5_000) {
    return { status: 'invalid_source_report', passedGates: [] };
  }
  return { status: 'source_reported_partial', source: trace.source, owner: candidate.owner,
    strategyId: candidate.strategyId, observedAt: new Date(observed).toISOString(),
    passedGates: [...gates],
    interpretation: 'These checks were reported by the market candidate path. They are not a complete proof of provider quality, model validation, or every upstream gate.',
  };
}

/** Record what the shared paper gate actually approved, without treating source scores as calibrated odds. */
export function paperApprovalEvidence(candidate, decision, reservedAt) {
  if (decision?.status !== 'paper-approved') throw new TypeError('Approval evidence requires an approved paper decision.');
  const signal = candidate?.signal && typeof candidate.signal === 'object' && !Array.isArray(candidate.signal)
    ? candidate.signal : {};
  const sourceValues = {
    score: finite(signal.score), confidence: finite(signal.confidence), probability: finite(signal.probability),
  };
  const quoteAt = Date.parse(candidate?.quoteTime ?? '');
  const reservedTime = Date.parse(reservedAt ?? '');
  const marketGateTrace = normalizeMarketGateTrace(candidate, reservedAt);
  return {
    schemaVersion: 1,
    scope: 'shared_paper_risk_gate_only', gateResult: 'paper-approved', recordedAt: reservedAt,
    quoteAgeAtReservationMs: Number.isFinite(quoteAt) && Number.isFinite(reservedTime)
      ? reservedTime - quoteAt : null,
    spreadPct: finite(decision.sizing?.spreadPct),
    grossRewardRisk: finite(decision.sizing?.grossRewardRisk),
    netRewardRiskAfterCostReserve: finite(decision.sizing?.rewardRisk),
    estimatedRoundTripCostReservePerUnitUsd: finite(decision.sizing?.roundTripCostReservePerUnitUsd),
    riskBudgetUsd: finite(decision.sizing?.riskBudgetUsd),
    reservedUnits: finite(decision.sizing?.units),
    sourceValuesStatus: Object.values(sourceValues).some((value) => value !== null)
      ? 'raw_unverified_values' : 'unavailable',
    sourceValues,
    marketStrategyGateRecordStatus: marketGateTrace.status,
    marketGateTrace,
    interpretation: 'Source values retain their original field names and are not calibrated probabilities; this is a reservation-time record, not proof of executable fill quality.',
  };
}
