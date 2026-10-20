const amount = (value) => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const closeEnough = (left, right) => left !== null && right !== null
  && Math.abs(left - right) <= Math.max(0.01, Math.abs(left) * 0.001);

/**
 * Compare configured, operator-reviewed contract identities/specifications with
 * provider definitions. This is diagnostic only: a match never verifies active
 * status, margin, session, settlement, liquidity, or trade eligibility.
 */
export function auditFuturesContractDiscovery(dayTrades = [], definitions = []) {
  if (!Array.isArray(dayTrades) || !Array.isArray(definitions)) throw new TypeError('Futures audit inputs must be arrays.');
  const byRawSymbol = new Map();
  for (const row of definitions) {
    const symbol = String(row?.providerRawSymbol ?? '').trim().toUpperCase();
    if (!symbol) continue;
    const matches = byRawSymbol.get(symbol) ?? [];
    matches.push(row);
    byRawSymbol.set(symbol, matches);
  }

  const comparisons = dayTrades.map((row) => {
    const contract = row?.contract ?? {};
    const rawSymbol = String(contract.providerRawSymbol ?? '').trim().toUpperCase();
    const candidates = rawSymbol ? byRawSymbol.get(rawSymbol) ?? [] : [];
    const expiryMatches = candidates.filter((candidate) => Date.parse(candidate.expiry) === Date.parse(contract.expiryAt ?? contract.expiry));
    if (!rawSymbol) return { symbol: String(contract.symbol ?? row?.symbol ?? 'unknown'), providerRawSymbol: null,
      status: 'configured_raw_symbol_missing', reasons: ['providerRawSymbol is not configured.'], tradeEligible: false };
    if (!expiryMatches.length) return { symbol: String(contract.symbol ?? row?.symbol ?? 'unknown'), providerRawSymbol: rawSymbol,
      status: candidates.length ? 'expiry_mismatch' : 'provider_definition_not_found',
      reasons: candidates.length ? ['Provider has this raw symbol with a different expiry.'] : ['No current provider definition matches this raw symbol.'],
      providerExpiries: candidates.map((candidate) => candidate.expiry).slice(0, 4), tradeEligible: false };

    const identities = expiryMatches.filter((candidate) => ['providerPublisherId', 'providerInstrumentId', 'providerDataset'].every((key) =>
      contract[key] == null || String(contract[key]).trim() === '' || String(candidate[key]) === String(contract[key])));
    if (identities.length !== 1) return { symbol: String(contract.symbol ?? row?.symbol ?? 'unknown'), providerRawSymbol: rawSymbol,
      status: identities.length ? 'ambiguous_provider_identity' : 'provider_identity_mismatch',
      reasons: [identities.length ? 'Multiple publisher-scoped identities match; specify the provider publisher and instrument.'
        : 'Configured provider identity disagrees with the returned definition.'], tradeEligible: false };
    const exactExpiry = identities[0];

    const comparisons = [
      ['tick_size_mismatch', amount(contract.tickSize), amount(exactExpiry.providerTickSize)],
      ['tick_value_mismatch', amount(contract.tickValueUsd), amount(exactExpiry.providerTickValue)],
      ['multiplier_mismatch', amount(contract.multiplier), amount(exactExpiry.providerContractMultiplier)],
    ];
    const reasons = comparisons.filter(([, configured, provider]) => configured !== null && provider !== null && !closeEnough(configured, provider))
      .map(([reason]) => reason);
    for (const [field, configured, provider] of comparisons) {
      if (configured === null || provider === null) reasons.push(`${field.replace('_mismatch', '')}_not_comparable`);
    }
    return { symbol: String(contract.symbol ?? row?.symbol ?? 'unknown'), providerRawSymbol: rawSymbol,
      providerInstrumentId: exactExpiry.providerInstrumentId ?? null, expiry: exactExpiry.expiry,
      status: reasons.some((reason) => reason.endsWith('_mismatch')) ? 'provider_spec_mismatch'
        : reasons.length ? 'partial_spec_comparison' : 'identity_and_price_specs_match',
      reasons: [...new Set(reasons)], providerReported: { tickSize: amount(exactExpiry.providerTickSize),
        tickValueUsd: amount(exactExpiry.providerTickValue), multiplier: amount(exactExpiry.providerContractMultiplier) },
      tradeEligible: false };
  });
  const statusCounts = {};
  for (const row of comparisons) statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
  const providerDefinitions = definitions.slice(0, 40).map((row) => ({ product: row.product, providerRawSymbol: row.providerRawSymbol,
    expiry: row.expiry, providerExchange: row.providerExchange ?? null, providerInstrumentId: row.providerInstrumentId ?? null,
    providerTickSize: amount(row.providerTickSize), providerTickValue: amount(row.providerTickValue),
    providerContractMultiplier: amount(row.providerContractMultiplier), tradeEligible: false }));
  return { configuredContracts: dayTrades.length, providerDefinitionCount: definitions.length,
    comparisons, statusCounts, providerDefinitions, note: 'Provider definitions are reference data only; matches do not verify active status, margin, session, settlement, liquidity, or executable fills.' };
}
