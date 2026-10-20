export const FUTURES_DAY_SESSION_DRAFT_STATUS = 'draft_requires_manual_review';

/** Keep review worksheets out of provider-backed strategy scans until an operator verifies them. */
export function splitFuturesDaySessionInputs(rows = []) {
  if (!Array.isArray(rows)) throw new TypeError('Futures day-trade inputs must be an array.');
  const draftRows = rows.filter((row) => row?.preparationStatus === FUTURES_DAY_SESSION_DRAFT_STATUS);
  const dayTrades = rows.filter((row) => row?.preparationStatus !== FUTURES_DAY_SESSION_DRAFT_STATUS);
  return { dayTrades, draftRows };
}

/** Explain whether the Futures intraday strategy actually received contract rows. */
export function summarizeFuturesDayTradeReadiness(dayTrades = [], contractDiscovery = {}, draftRows = []) {
  if (!Array.isArray(dayTrades)) throw new TypeError('Futures day-trade inputs must be an array.');
  if (!Array.isArray(draftRows)) throw new TypeError('Futures draft inputs must be an array.');
  const definitionCount = Array.isArray(contractDiscovery.contracts) ? contractDiscovery.contracts.length : 0;
  const draftRejectionReasons = draftRows.length ? [{ reason: 'contract_review_required', count: draftRows.length }] : [];
  const activityInputs = dayTrades.filter((row) => row?.discoveryContext?.cohort === 'broad_activity_reviewed').length;
  if (activityInputs) return {
    status: 'discovered_and_reviewed_inputs_present', evaluatedRows: dayTrades.length,
    activityInputs, configuredInputs: dayTrades.length - activityInputs, draftsSkipped: draftRows.length, draftRejectionReasons, providerDefinitions: definitionCount,
    note: `${activityInputs} activity-selected contract(s) with reviewed metadata entered detailed analysis; fresh provider data, catalyst, strategy and portfolio risk approval are still required.`,
  };
  if (dayTrades.length) return {
    status: 'configured_inputs_present', evaluatedRows: dayTrades.length, draftsSkipped: draftRows.length, draftRejectionReasons, providerDefinitions: definitionCount,
    note: `Configured contract/session rows were passed to the day strategy; row-level data, catalyst, strategy, and risk gates still determine eligibility.${draftRows.length ? ` ${draftRows.length} unreviewed draft row(s) were skipped before provider requests.` : ''}`,
  };
  if (draftRows.length) return {
    status: 'draft_contracts_only', evaluatedRows: 0, draftsSkipped: draftRows.length, draftRejectionReasons, providerDefinitions: definitionCount,
    note: `${draftRows.length} unreviewed contract draft row(s) were skipped before day-session, H1, and calendar provider requests; no day strategy rows were evaluated.`,
  };
  if (definitionCount) return {
    status: 'no_configured_day_contracts', evaluatedRows: 0, draftsSkipped: 0, draftRejectionReasons, providerDefinitions: definitionCount,
    note: `${definitionCount} dated provider definition(s) are research-only. No verified active-contract session/catalyst/quote rows were evaluated by the day strategy.`,
  };
  const discoveryStatus = String(contractDiscovery.status ?? 'unknown');
  if (['provider_error', 'credentials_missing', 'cost_cap_required', 'cost_cap_exceeded', 'incomplete_stream', 'refresh_locked', 'refresh_backoff'].includes(discoveryStatus)) return {
    status: 'blocked_contract_discovery', evaluatedRows: 0, draftsSkipped: 0, draftRejectionReasons, providerDefinitions: 0,
    note: `No day-trade contract rows were configured and provider contract discovery is unavailable (${discoveryStatus}); the day strategy did not run.`,
  };
  return {
    status: 'no_configured_day_contracts', evaluatedRows: 0, draftsSkipped: 0, draftRejectionReasons, providerDefinitions: 0,
    note: `No day-trade contract rows were configured (dated-definition discovery: ${discoveryStatus}); the day strategy did not run. Continuous-universe context is not an active-contract scan.`,
  };
}
