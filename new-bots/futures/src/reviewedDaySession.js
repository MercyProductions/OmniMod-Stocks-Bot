import { createHash } from 'node:crypto';
import { isFreshClearCatalystReview } from '../../shared/catalystReview.js';
import { validateFuturesSession } from './dayStrategy.js';
import { validateFuturesSettlementReview } from './contractReview.js';
import { parseFuturesExpiry, validateActiveFutureContract } from './universe.js';

const finitePositive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const finiteNonNegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const safeHttpsCitation = (value) => {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
};

export function fingerprintFuturesDraft(contents) {
  if (typeof contents !== 'string' && !Buffer.isBuffer(contents)) throw new TypeError('Draft contents must be text or a Buffer.');
  return createHash('sha256').update(contents).digest('hex');
}

export function buildFuturesDaySessionReviewTemplate(draft, draftSha256) {
  if (!draft || draft.draft !== true || !Array.isArray(draft.dayTrades)
    || !/^[a-f0-9]{64}$/i.test(String(draftSha256 ?? ''))) throw new TypeError('An unapproved draft and its SHA-256 fingerprint are required.');
  return { schemaVersion: 1, draftSha256: String(draftSha256).toLowerCase(), sessionDate: null,
    approvals: draft.dayTrades.map((row) => ({ providerRawSymbol: String(row?.contract?.providerRawSymbol ?? '').toUpperCase(),
      contract: { contractId: null, exposureKey: null, activeContract: false, contractSpecVerified: false,
        expiry: row?.contract?.expiryAt ?? null, specSource: null, specVerifiedAt: null, tickSize: null, tickValueUsd: null,
        multiplier: null, initialMarginUsd: null, maintenanceMarginUsd: null,
        settlementReview: { settlementType: null, source: null, reviewedAt: null, lastTradeAt: null, firstNoticeAt: null } },
      session: { marketDate: null, timeZone: null, openTime: null, closeTime: null, source: null, reviewedAt: null },
      catalystReview: { status: null, source: null, summary: null, reviewedAt: null },
      costs: { roundTripFeesPerContract: null, slippageReservePerContract: null } })) };
}

/** Compile a human-reviewed provider draft into the exact paper-runner schema, retaining every gate. */
export function compileReviewedFuturesDaySession(draft, review, { draftSha256, now = Date.now() } = {}) {
  if (!draft || typeof draft !== 'object' || draft.draft !== true || !Array.isArray(draft.dayTrades))
    throw new TypeError('Input must be an unapproved Futures day-session draft.');
  if (!review || review.schemaVersion !== 1 || !Array.isArray(review.approvals) || !review.approvals.length)
    throw new TypeError('Review must use schemaVersion 1 and contain at least one approval.');
  if (!/^[a-f0-9]{64}$/i.test(String(draftSha256 ?? ''))
    || String(review.draftSha256 ?? '').toLowerCase() !== String(draftSha256).toLowerCase())
    throw new Error('Review draft fingerprint does not match the exact draft file.');
  if (!Number.isFinite(now)) throw new TypeError('Review compiler clock must be finite.');

  const sourceRows = new Map(draft.dayTrades.map((row) => [String(row?.contract?.providerRawSymbol ?? '').toUpperCase(), row]));
  const seen = new Set();
  const dayTrades = [];
  const rejected = [];
  for (const approval of review.approvals) {
    const raw = String(approval?.providerRawSymbol ?? '').trim().toUpperCase();
    const source = sourceRows.get(raw);
    const errors = [];
    if (!raw || !source) errors.push('draft_provider_raw_symbol_not_found');
    if (seen.has(raw)) errors.push('duplicate_review_approval');
    seen.add(raw);
    if (source?.preparationStatus !== 'draft_requires_manual_review') errors.push('source_row_not_review_draft');
    const contractReview = approval?.contract;
    const session = approval?.session;
    const costs = approval?.costs;
    if (!contractReview || typeof contractReview !== 'object') errors.push('verified_contract_metadata_missing');
    if (!session || typeof session !== 'object') errors.push('verified_session_metadata_missing');
    if (!approval?.catalystReview || typeof approval.catalystReview !== 'object') errors.push('catalyst_review_missing');
    if (contractReview && !safeHttpsCitation(contractReview.specSource)) errors.push('contract_spec_source_must_be_clean_https');
    if (session && !safeHttpsCitation(session.source)) errors.push('session_source_must_be_clean_https');
    if (approval?.catalystReview && !safeHttpsCitation(approval.catalystReview.source)) errors.push('catalyst_source_must_be_clean_https');
    if (contractReview?.settlementReview && !safeHttpsCitation(contractReview.settlementReview.source)) errors.push('settlement_source_must_be_clean_https');
    if (!finiteNonNegative(costs?.roundTripFeesPerContract) || !finiteNonNegative(costs?.slippageReservePerContract))
      errors.push('explicit_contract_cost_reserves_required');
    if (source && contractReview) {
      const draftExpiry = parseFuturesExpiry(source.contract.expiryAt);
      const reviewedExpiry = parseFuturesExpiry(contractReview.expiryAt ?? contractReview.expiry);
      if (!Number.isFinite(reviewedExpiry) || reviewedExpiry !== draftExpiry) errors.push('reviewed_expiry_does_not_match_provider_draft');
      const contract = { ...source.contract, ...contractReview, symbol: source.contract.symbol,
        productName: source.contract.productName, assetClass: source.contract.assetClass, underlying: source.contract.underlying,
        providerSymbol: source.contract.providerSymbol, providerRawSymbol: raw,
        providerDataset: source.contract.providerDataset, providerRoot: source.contract.providerRoot,
        providerInstrumentId: source.contract.providerInstrumentId, providerPublisherId: source.contract.providerPublisherId,
        providerExchange: source.contract.providerExchange, providerDefinitionTimestamp: source.contract.providerDefinitionTimestamp,
        activeContract: contractReview.activeContract === true, contractSpecVerified: contractReview.contractSpecVerified === true,
        expiryAt: source.contract.expiryAt, expiry: source.contract.expiryAt,
      };
      if (!errors.includes('reviewed_expiry_does_not_match_provider_draft')) {
        const inspected = (() => { try { return { contract: validateActiveFutureContract(contract, { now }) }; }
          catch (error) { return { reasons: error.reasons ?? ['active_contract_metadata_invalid'] }; } })();
        if (inspected.reasons) errors.push(...inspected.reasons);
        const sessionCheck = validateFuturesSession(session, { now });
        if (!sessionCheck.valid) errors.push(...sessionCheck.reasons);
        else if (session.marketDate !== String(review.sessionDate ?? '')) errors.push('session_date_mismatch');
        if (!isFreshClearCatalystReview(approval.catalystReview, { now })) errors.push('catalyst_review_not_fresh_and_clear');
        const settlement = validateFuturesSettlementReview(contract, { now });
        errors.push(...settlement.reasons);
        if (!errors.length) dayTrades.push({ ...source, preparationStatus: 'operator_reviewed_paper_input',
          contract: inspected.contract, session: { ...session, reviewedAt: new Date(Date.parse(session.reviewedAt)).toISOString() },
          catalystReview: { ...approval.catalystReview, reviewedAt: new Date(Date.parse(approval.catalystReview.reviewedAt)).toISOString() },
          config: { ...source.config, roundTripFeesPerContract: costs.roundTripFeesPerContract,
            slippageReservePerContract: costs.slippageReservePerContract } });
      }
    }
    if (errors.length) rejected.push({ providerRawSymbol: raw || null, reasons: [...new Set(errors)] });
  }
  if (rejected.length || dayTrades.length !== review.approvals.length) {
    const error = new Error(`Futures review rejected ${rejected.length} of ${review.approvals.length} approval row(s).`);
    error.rejected = rejected;
    throw error;
  }
  if (new Set(dayTrades.map((row) => row.contract.contractId.toUpperCase())).size !== dayTrades.length)
    throw new Error('Review approvals contain duplicate contract IDs.');
  return { schemaVersion: 1, sessionDate: String(review.sessionDate), marks: [], dayTrades,
    reviewCompilation: { status: 'operator-reviewed-inputs', compiledAt: new Date(now).toISOString(),
      sourceDraftSha256: String(draftSha256).toLowerCase(), reviewedRows: dayTrades.length,
      note: 'Paper-runner input only; live trading is not enabled. Provider verification and strategy/risk gates still run per scan.' } };
}
