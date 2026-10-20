import { parseFuturesExpiry } from './universe.js';

const parseTimestamp = (value) => {
  if (value == null || value === '') return NaN;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return NaN;
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : NaN;
};
const isHttpsSource = (value) => {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
};

/** Validate point-in-time settlement/delivery terms at an entry decision time. */
export function validateFuturesSettlementReview(contract, { now = Date.now(), maxReviewAgeMs = 90 * 24 * 60 * 60_000,
  entryBufferMs = 0 } = {}) {
  const terms = contract?.settlementReview;
  const termsAt = parseTimestamp(terms?.reviewedAt);
  const termsFresh = Number.isFinite(termsAt) && termsAt <= now && now - termsAt <= maxReviewAgeMs;
  const settlementType = String(terms?.settlementType ?? '');
  const lastTradeAt = parseTimestamp(terms?.lastTradeAt);
  const firstNoticeAt = parseTimestamp(terms?.firstNoticeAt);
  const contractExpiry = parseFuturesExpiry(contract?.expiryAt ?? contract?.expiry);
  const reasons = [];
  if (!Number.isFinite(now) || !Number.isFinite(maxReviewAgeMs) || maxReviewAgeMs <= 0
    || !Number.isFinite(entryBufferMs) || entryBufferMs < 0 || entryBufferMs > 30 * 24 * 60 * 60_000) reasons.push('settlement_review_policy_invalid');
  if (!terms || !['cash_settled', 'physical_delivery'].includes(settlementType) || !isHttpsSource(terms?.source) || !termsFresh
    || !Number.isFinite(lastTradeAt) || lastTradeAt <= now) reasons.push('settlement_terms_review_missing_stale_or_invalid');
  if (Number.isFinite(contractExpiry) && Number.isFinite(lastTradeAt) && lastTradeAt > contractExpiry) reasons.push('last_trade_after_contract_expiry');
  if (settlementType === 'physical_delivery' && (!Number.isFinite(firstNoticeAt) || firstNoticeAt <= now || firstNoticeAt > lastTradeAt)) {
    reasons.push('physical_delivery_first_notice_cutoff_missing_or_invalid');
  }
  const entryCutoffAt = settlementType === 'physical_delivery' ? Math.min(firstNoticeAt, lastTradeAt) : lastTradeAt;
  if (Number.isFinite(entryCutoffAt) && entryCutoffAt - now <= entryBufferMs) reasons.push('settlement_entry_cutoff_buffer_active');
  return {
    status: reasons.length ? 'invalid' : 'valid', reasons,
    normalized: reasons.length ? null : {
      settlementType, source: terms.source.trim(), reviewedAt: new Date(termsAt).toISOString(),
      lastTradeAt: new Date(lastTradeAt).toISOString(),
      firstNoticeAt: Number.isFinite(firstNoticeAt) ? new Date(firstNoticeAt).toISOString() : null,
      entryCutoffAt: new Date(entryCutoffAt).toISOString(), entryBufferMs,
    },
  };
}

/** Compare provider definitions with operator-verified contract inputs without promoting either. */
export function reviewFuturesContractDefinitions(definitions, dayTrades, { now = Date.now(), maxDefinitionAgeMs = 24 * 60 * 60_000,
  maxReviewAgeMs = 90 * 24 * 60 * 60_000 } = {}) {
  if (!Array.isArray(definitions) || !Array.isArray(dayTrades)) throw new TypeError('Futures definitions and dayTrades must be arrays.');
  if (![now, maxDefinitionAgeMs, maxReviewAgeMs].every(Number.isFinite) || maxDefinitionAgeMs <= 0 || maxReviewAgeMs <= 0) {
    throw new TypeError('Futures contract review time and age limits must be valid.');
  }
  const configs = new Map();
  for (const row of dayTrades) {
    const raw = String(row?.contract?.providerRawSymbol ?? '').trim().toUpperCase();
    if (raw) configs.set(raw, row.contract);
  }
  const seen = new Set();
  const reviewed = definitions.map((definition) => {
    const rawSymbol = String(definition?.providerRawSymbol ?? '').trim().toUpperCase();
    const contract = configs.get(rawSymbol);
    const reasons = [];
    seen.add(rawSymbol);
    if (!rawSymbol) reasons.push('provider_raw_symbol_missing');
    if (!contract) reasons.push('verified_day_contract_config_missing');
    const providerExpiry = parseFuturesExpiry(definition?.expiry);
    const configuredExpiry = parseFuturesExpiry(contract?.expiryAt ?? contract?.expiry);
    if (!Number.isFinite(providerExpiry)) reasons.push('provider_expiry_invalid');
    if (contract && !Number.isFinite(configuredExpiry)) reasons.push('configured_expiry_invalid');
    if (Number.isFinite(providerExpiry) && providerExpiry <= now) reasons.push('provider_contract_expired');
    if (contract && Number.isFinite(providerExpiry) && Number.isFinite(configuredExpiry) && providerExpiry !== configuredExpiry) reasons.push('provider_configured_expiry_mismatch');
    if (contract && contract.providerRawSymbol?.toUpperCase() !== rawSymbol) reasons.push('provider_contract_identity_mismatch');
    if (contract && (contract.activeContract !== true || contract.contractSpecVerified !== true || !contract.contractId)) reasons.push('active_contract_spec_not_verified');

    const specAt = parseTimestamp(contract?.specVerifiedAt);
    if (!contract || !isHttpsSource(contract.specSource) || !Number.isFinite(specAt)
      || specAt > now || now - specAt > maxReviewAgeMs) reasons.push('configured_contract_spec_source_or_timestamp_missing_stale_or_future');
    const tickSize = Number(contract?.tickSize), multiplier = Number(contract?.multiplier);
    const tickValueUsd = Number(contract?.tickValueUsd), initialMarginUsd = Number(contract?.initialMarginUsd);
    const maintenanceMarginUsd = Number(contract?.maintenanceMarginUsd);
    if (!(tickSize > 0) || !(multiplier > 0) || !(tickValueUsd > 0)
      || Math.abs(tickSize * multiplier - tickValueUsd) > Math.max(0.01, tickValueUsd * 0.001)
      || !(initialMarginUsd > 0) || !(maintenanceMarginUsd > 0) || maintenanceMarginUsd > initialMarginUsd) {
      reasons.push('configured_tick_multiplier_or_margin_terms_invalid');
    }

    // Local fetch time cannot stand in for the provider's definition timestamp.
    const definitionAt = parseTimestamp(definition?.definitionTimestamp);
    if (!Number.isFinite(definitionAt)) reasons.push('provider_definition_timestamp_missing');
    else if (definitionAt > now + 60_000 || now - definitionAt > maxDefinitionAgeMs) reasons.push('provider_definition_stale_or_future');

    const providerTick = Number(definition?.providerTickSize), configuredTick = Number(contract?.tickSize);
    if (!(providerTick > 0)) reasons.push('provider_tick_size_missing_or_invalid');
    if (Number.isFinite(providerTick) && providerTick > 0 && Number.isFinite(configuredTick) && configuredTick > 0
      && Math.abs(providerTick - configuredTick) > Math.max(1e-8, providerTick * 1e-6)) reasons.push('provider_configured_tick_size_mismatch');
    const providerMultiplier = Number(definition?.providerContractMultiplier), configuredMultiplier = Number(contract?.multiplier);
    if (!(providerMultiplier > 0)) reasons.push('provider_contract_multiplier_missing_or_invalid');
    if (Number.isFinite(providerMultiplier) && providerMultiplier > 0 && Number.isFinite(configuredMultiplier) && configuredMultiplier > 0
      && Math.abs(providerMultiplier - configuredMultiplier) > Math.max(1e-8, providerMultiplier * 1e-6)) reasons.push('provider_configured_multiplier_mismatch');

    const settlement = validateFuturesSettlementReview(contract, { now, maxReviewAgeMs });
    reasons.push(...settlement.reasons);
    const settlementType = settlement.normalized?.settlementType ?? String(contract?.settlementReview?.settlementType ?? '');
    const firstNoticeAt = parseTimestamp(contract?.settlementReview?.firstNoticeAt);
    const lastTradeAt = parseTimestamp(contract?.settlementReview?.lastTradeAt);
    if (Number.isFinite(providerExpiry) && Number.isFinite(lastTradeAt) && lastTradeAt > providerExpiry) reasons.push('last_trade_after_provider_expiry');

    const status = reasons.some((reason) => reason.includes('mismatch') || reason.includes('expired') || reason.includes('invalid') || reason.includes('stale_or_future'))
      ? 'review_failed' : reasons.length ? 'verification_incomplete' : 'human_review_ready';
    return { provider: 'Databento', providerRawSymbol: rawSymbol || null, product: definition?.product ?? null,
      contractId: contract?.contractId ?? null, status, reasons: [...new Set(reasons)],
      contractSpec: {
        source: isHttpsSource(contract?.specSource) ? contract.specSource.trim() : null,
        verifiedAt: Number.isFinite(specAt) ? new Date(specAt).toISOString() : null,
        providerTickSize: Number.isFinite(providerTick) && providerTick > 0 ? providerTick : null,
        configuredTickSize: Number.isFinite(configuredTick) && configuredTick > 0 ? configuredTick : null,
        providerMultiplier: Number.isFinite(providerMultiplier) && providerMultiplier > 0 ? providerMultiplier : null,
        configuredMultiplier: Number.isFinite(configuredMultiplier) && configuredMultiplier > 0 ? configuredMultiplier : null,
        tickValueUsd: Number.isFinite(tickValueUsd) && tickValueUsd > 0 ? tickValueUsd : null,
        initialMarginUsd: Number.isFinite(initialMarginUsd) && initialMarginUsd > 0 ? initialMarginUsd : null,
        maintenanceMarginUsd: Number.isFinite(maintenanceMarginUsd) && maintenanceMarginUsd > 0 ? maintenanceMarginUsd : null,
      },
      providerExpiry: Number.isFinite(providerExpiry) ? new Date(providerExpiry).toISOString() : null,
      configuredExpiry: Number.isFinite(configuredExpiry) ? new Date(configuredExpiry).toISOString() : null,
      settlementType: ['cash_settled', 'physical_delivery'].includes(settlementType) ? settlementType : 'unknown',
      settlementReviewSource: isHttpsSource(contract?.settlementReview?.source) ? contract.settlementReview.source.trim() : null,
      firstNoticeAt: Number.isFinite(firstNoticeAt) ? new Date(firstNoticeAt).toISOString() : null,
      lastTradeAt: Number.isFinite(lastTradeAt) ? new Date(lastTradeAt).toISOString() : null,
      liveQuoteVerification: 'required_at_candidate_scan', tradeEligible: false };
  });
  for (const rawSymbol of configs.keys()) {
    if (!seen.has(rawSymbol)) reviewed.push({ provider: 'Databento', providerRawSymbol: rawSymbol, status: 'review_failed',
      reasons: ['configured_contract_missing_from_current_provider_definitions'], tradeEligible: false, liveQuoteVerification: 'required_at_candidate_scan' });
  }
  return { status: 'complete', definitions: definitions.length, configuredContracts: configs.size,
    matched: reviewed.filter((row) => row.contractId).length,
    humanReviewReady: reviewed.filter((row) => row.status === 'human_review_ready').length,
    incomplete: reviewed.filter((row) => row.status === 'verification_incomplete').length,
    failed: reviewed.filter((row) => row.status === 'review_failed').length,
    tradeEligible: 0, rows: reviewed };
}
