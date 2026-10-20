import { evaluateOpeningRangeBreakout } from './strategies.js';
import { refreshEtfDecisionQuotes, etfQuoteAges } from './decisionQuotes.js';
import { evaluatePaperCandidate, reservePaperCandidate } from '../../shared/paperRisk.js';

/** Re-evaluate the entire strategy/risk decision against current quotes. This
 * function never manufactures bars, modifies research timestamps or fills. */
export async function evaluateEtfEntries(inputs, { sourceMode, env = process.env, portfolio, policy, strategyConfig = {}, statePath,
  clock = Date.now, refresh = refreshEtfDecisionQuotes, reserve = reservePaperCandidate, providerMetrics = [], quoteRefreshBudgetMs = 8000 } = {}) {
  if (!Number.isFinite(quoteRefreshBudgetMs) || quoteRefreshBudgetMs <= 0 || quoteRefreshBudgetMs > 15000) throw new TypeError('Invalid ETF workflow quote budget.');
  let spent = 0;
  const started = clock(), diagnostics = { beforeQualification: etfQuoteAges(inputs, started), qualification: null, rowChecks: [], entryChecks: [], decisions: [] };
  const refreshCurrent = async rows => {
    const before = clock();
    const result = await refresh(rows, { env, clock, providerMetrics, maxQuoteAgeMs: strategyConfig.maxQuoteAgeMs ?? 15000,
      budgetMs: Math.max(0, quoteRefreshBudgetMs - spent) });
    spent += Math.max(0, clock() - before);
    return result;
  };
  const initial = sourceMode === 'alpaca' ? await refreshCurrent(inputs) : { trades: inputs, diagnostics: null };
  diagnostics.qualification = initial.diagnostics;
  const results = [], observations = [];
  for (let input of initial.trades) {
    if (sourceMode === 'alpaca' && !input.quoteRefreshReason) {
      // Earlier reservations may await a lock; later rows need a current check.
      const current = await refreshCurrent([input]);
      input = current.trades[0]; diagnostics.rowChecks.push(current.diagnostics);
    }
    const evaluate = () => evaluateOpeningRangeBreakout({ ...input, now: clock(), config: { ...strategyConfig, ...input.config,
      requireCatalystReview: sourceMode === 'alpaca', maxCatalystReviewAgeMs: Number(env.ETF_MAX_CATALYST_REVIEW_AGE_MS || 30 * 60000) } });
    let strategy = evaluate(), decision;
    if (strategy.status === 'candidate') decision = evaluatePaperCandidate(strategy.candidate, portfolio, { ...policy, now: clock() });
    if (strategy.status === 'candidate' && decision.status === 'paper-approved' && sourceMode === 'alpaca') {
      const current = await refreshCurrent([input]);
      input = current.trades[0]; diagnostics.entryChecks.push(current.diagnostics);
      strategy = evaluate();
      if (strategy.status === 'candidate') decision = evaluatePaperCandidate(strategy.candidate, portfolio, { ...policy, now: clock() });
    }
    const at = clock();
    observations.push({ instrumentKey: String(input.symbol || '').toUpperCase(), strategyInput: { ...input, now: at } });
    diagnostics.decisions.push({ ...etfQuoteAges([input], at)[0], stage: 'strategy_and_risk' });
    if (strategy.status !== 'candidate') {
      results.push({ symbol: input.symbol ?? null, strategy: strategy.strategy, status: strategy.status,
        reasons: [...new Set([...strategy.reasons, ...(input.quoteRefreshReason ? [input.quoteRefreshReason] : [])])], primaryResearch: input.primaryResearch });
      continue;
    }
    if (decision.status !== 'paper-approved') {
      results.push({ symbol: input.symbol, strategy: strategy.strategy, status: 'risk-blocked', candidate: strategy.candidate, decision, primaryResearch: input.primaryResearch });
      continue;
    }
    const reservation = await reserve(strategy.candidate, decision, { statePath, now: clock(), observationClock: clock, emergencyStop: policy.emergencyStop });
    results.push({ symbol: input.symbol, strategy: strategy.strategy, status: reservation.status,
      candidate: strategy.candidate, decision, reservation, primaryResearch: input.primaryResearch });
    if (reservation.status === 'reserved') portfolio.openPositions.push(reservation.order);
  }
  diagnostics.durationMs = Math.max(0, clock() - started);
  diagnostics.quoteWorkMs = spent;
  diagnostics.quoteRefreshBudgetMs = quoteRefreshBudgetMs;
  return { results, observations, diagnostics };
}
