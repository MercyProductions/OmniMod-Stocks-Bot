import { parseFuturesExpiry } from './universe.js';

const rawSymbolPattern = /^[A-Z0-9]{2,16}$/;
const definitionTimestamp = (value) => {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return NaN;
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : NaN;
};
const positiveOrNull = (value) => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

/**
 * Turn dated provider definitions into an editable, deliberately non-eligible
 * review draft. Provider claims are isolated under providerReference; the
 * fields consumed as operator-verified contract terms remain unset.
 */
export function prepareFuturesDaySessionDraft(definitions, products, { now = Date.now(), maxDefinitionAgeMs = 24 * 60 * 60_000 } = {}) {
  if (!Array.isArray(definitions) || !Array.isArray(products)) throw new TypeError('Futures definitions and products must be arrays.');
  if (!Number.isFinite(now) || !Number.isFinite(maxDefinitionAgeMs) || maxDefinitionAgeMs <= 0) throw new TypeError('Futures draft clock and definition age limit must be valid.');
  const productsByName = new Map(products.map((product) => [String(product?.symbol ?? '').trim(), product]));
  const seen = new Set();
  const dayTrades = [];
  const rejectedDefinitions = [];
  for (const [index, definition] of definitions.entries()) {
    const rawSymbol = String(definition?.providerRawSymbol ?? '').trim().toUpperCase();
    const product = productsByName.get(String(definition?.product ?? '').trim());
    const expiryAt = parseFuturesExpiry(definition?.expiry);
    const definitionAt = definitionTimestamp(definition?.definitionTimestamp);
    const providerInstrumentId = String(definition?.providerInstrumentId ?? '').trim();
    const reasonCodes = [];
    if (!rawSymbol) reasonCodes.push('provider_raw_symbol_missing');
    else if (!rawSymbolPattern.test(rawSymbol)) reasonCodes.push('provider_raw_symbol_invalid');
    if (!product) reasonCodes.push('product_not_in_reviewed_registry');
    if (!providerInstrumentId) reasonCodes.push('provider_instrument_id_missing');
    if (!Number.isFinite(definitionAt)) reasonCodes.push('provider_definition_timestamp_missing_or_invalid');
    else if (definitionAt > now) reasonCodes.push('provider_definition_timestamp_in_future');
    else if (now - definitionAt > maxDefinitionAgeMs) reasonCodes.push('provider_definition_stale');
    if (!Number.isFinite(expiryAt)) reasonCodes.push('provider_expiry_invalid');
    else if (expiryAt <= now) reasonCodes.push('provider_contract_expired');
    if (rawSymbolPattern.test(rawSymbol) && seen.has(rawSymbol)) reasonCodes.push('duplicate_provider_raw_symbol');
    if (reasonCodes.length) {
      rejectedDefinitions.push({ definitionIndex: index + 1, providerRawSymbol: rawSymbol || null,
        providerInstrumentId: providerInstrumentId || null, reasonCodes });
      continue;
    }
    seen.add(rawSymbol);
    dayTrades.push({
      preparationStatus: 'draft_requires_manual_review',
      contract: {
        symbol: rawSymbol,
        productName: String(product.symbol),
        assetClass: String(product.assetClass ?? ''),
        underlying: String(product.underlying ?? product.symbol),
        providerSymbol: String(definition.providerSymbol ?? product.providerSymbol),
        providerRawSymbol: rawSymbol,
        providerDataset: definition.providerDataset ?? null,
        providerRoot: definition.providerRoot ?? null,
        providerInstrumentId,
        providerPublisherId: definition.providerPublisherId ?? null,
        providerExchange: definition.providerExchange ?? null,
        providerDefinitionTimestamp: definition.definitionTimestamp ?? null,
        expiryAt: new Date(expiryAt).toISOString(),
        // These provider-supplied claims are references for review only. They
        // are intentionally not copied into the strategy's trusted spec fields.
        providerReference: {
          source: definition.definitionSource ?? 'Databento dated definition',
          tickSize: positiveOrNull(definition.providerTickSize),
          tickValueUsd: positiveOrNull(definition.providerTickValue),
          multiplier: positiveOrNull(definition.providerContractMultiplier),
          contractSize: positiveOrNull(definition.providerContractSize),
          unitOfMeasure: definition.providerUnitOfMeasure ?? null,
          currency: definition.providerCurrency ?? null,
        },
        contractId: null,
        exposureKey: null,
        activeContract: false,
        contractSpecVerified: false,
        specSource: null,
        specVerifiedAt: null,
        tickSize: null,
        tickValueUsd: null,
        multiplier: null,
        initialMarginUsd: null,
        maintenanceMarginUsd: null,
        settlementReview: null,
      },
      session: null,
      catalystReview: { status: 'blocked', source: null, summary: 'Operator review required; no catalyst clearance is inferred.', reviewedAt: null },
      trendBars: [],
      bars: [],
      quote: null,
      config: { roundTripFeesPerContract: null, slippageReservePerContract: null },
    });
  }
  return {
    schemaVersion: 1,
    draft: true,
    createdAt: new Date(now).toISOString(),
    sessionDate: null,
    marks: [],
    dayTrades,
    definitionsReceived: definitions.length,
    draftedDefinitions: dayTrades.length,
    rejectedDefinitions,
    partial: rejectedDefinitions.length > 0,
    reviewChecklist: [
      'Select the currently active contract for each product; an unexpired definition is not proof of activity.',
      'Independently verify broker contract ID, tick size/value, multiplier, initial and maintenance margin, and current expiry.',
      'Add canonical cross-market exposure key, verified exchange session/timezone, and source-backed settlement/first-notice terms.',
      'Review scheduled macro and contract-specific catalysts; add current completed bars and executable quote or enable an entitled feed.',
      'Set explicit round-trip commissions and slippage reserves, paper equity, and risk policy before paper approval.',
    ],
    note: 'This draft is not a trade universe. Provider references remain unverified; trusted contract, session, catalyst, market-data, cost, and exposure fields are intentionally unset. Do not use as a verified production day-session file until every review gate is completed.',
  };
}
