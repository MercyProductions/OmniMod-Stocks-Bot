export const STOCK_DISCOVERY_VERSION = 'stocks-directory-integrity-v2';
const EXCHANGES = new Set(['AMEX', 'ARCA', 'BATS', 'NYSE', 'NASDAQ', 'NYSEARCA']);
const canonical = (value) => typeof value === 'string' ? value.trim().toUpperCase() : '';

/** Every returned directory record gets a disposition; names never establish security type. */
export function classifyStockDirectory(assets, { configuredSymbols = [], excludedSymbols = [], contextSymbols = [] } = {}) {
  if (!Array.isArray(assets)) throw new TypeError('Alpaca directory must be an array.');
  const configured = new Set(configuredSymbols.map(canonical)), excluded = new Set(excludedSymbols.map(canonical));
  const context = new Set(contextSymbols.map(canonical)), ids = new Map(), activeSymbols = new Map();
  for (const asset of assets) {
    if (typeof asset?.id === 'string' && asset.id.trim()) ids.set(asset.id, (ids.get(asset.id) || 0) + 1);
    if (asset?.status === 'active') { const symbol = canonical(asset.symbol); activeSymbols.set(symbol, (activeSymbols.get(symbol) || 0) + 1); }
  }
  const rows = [], eligible = [], counts = {};
  for (const asset of assets) {
    const symbol = canonical(asset?.symbol), exchange = canonical(asset?.exchange);
    const reason = typeof asset?.id !== 'string' || !asset.id.trim() || !/^[A-Z][A-Z0-9.-]{0,10}$/.test(symbol) ? 'invalid_directory_identity'
      : ids.get(asset.id) > 1 ? 'duplicate_directory_id'
        : !['active', 'inactive'].includes(asset.status) ? 'unknown_listing_status'
          : asset.status !== 'active' ? 'inactive_listing'
            : activeSymbols.get(symbol) > 1 ? 'ambiguous_active_symbol'
              : asset.class !== 'us_equity' ? 'unsupported_asset_class'
                : !EXCHANGES.has(exchange) ? exchange === 'OTC' ? 'otc_feed_not_configured' : 'unsupported_listing_exchange'
                  : asset.tradable !== true ? 'not_account_tradable'
                    : context.has(symbol) ? 'market_context'
                      : excluded.has(symbol) ? 'etf_etp_primary_owner'
                        : configured.has(symbol) ? 'configured_for_deep_analysis' : null;
    const row = { id: typeof asset?.id === 'string' ? asset.id : null, symbol, exchange, status: asset?.status ?? null,
      name: typeof asset?.name === 'string' ? asset.name : '', assetClass: asset?.class ?? null,
      disposition: reason ? 'excluded_from_dynamic_screen' : 'eligible', reasonCode: reason };
    rows.push(row);
    if (reason) counts[reason] = (counts[reason] || 0) + 1;
    else eligible.push(row);
  }
  eligible.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { rows, eligible, diagnostics: { version: STOCK_DISCOVERY_VERSION, providerInstruments: assets.length,
    uniqueProviderIds: ids.size, activeRecords: assets.filter((a) => a?.status === 'active').length,
    eligibleStockInstruments: eligible.length + (counts.configured_for_deep_analysis || 0),
    eligibleDynamicInstruments: eligible.length, configuredForDeepAnalysis: counts.configured_for_deep_analysis || 0,
    excludedRecords: assets.length - eligible.length, exclusionReasons: counts,
    enumeration: 'all-status asset-class directory; documented non-paginated array',
    securityTypeCoverage: 'Provider us_equity plus ETF/ETP ownership exclusions; ADR/common/preferred/warrant subtypes not independently established' } };
}

export function stockDirectoryChanges(previous, current) {
  if (!Array.isArray(previous)) return { baseline: true, added: [], noLongerReported: [], changed: [] };
  const fingerprint = (row) => JSON.stringify([row.symbol, row.status, row.class, row.exchange, row.tradable]);
  const before = new Map(previous.filter((r) => r?.id).map((r) => [r.id, r]));
  const after = new Map(current.filter((r) => r?.id).map((r) => [r.id, r]));
  return { baseline: false,
    added: [...after].filter(([id]) => !before.has(id)).map(([id, row]) => ({ id, symbol: row.symbol })),
    noLongerReported: [...before].filter(([id]) => !after.has(id)).map(([id, row]) => ({ id, symbol: row.symbol })),
    changed: [...after].filter(([id, row]) => before.has(id) && fingerprint(row) !== fingerprint(before.get(id)))
      .map(([id, row]) => ({ id, symbol: row.symbol, previousStatus: before.get(id).status, status: row.status })) };
}
