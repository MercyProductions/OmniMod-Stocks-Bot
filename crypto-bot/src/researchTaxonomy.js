export function classifyResearchMetadata(asset = {}, now = new Date(), settings = {}, registry = {}) {
  const technicals = asset.marketData?.technicals || {};
  const technicalsReady = Boolean(technicals.dataSufficient);
  const setupFamily = !technicalsReady ? 'snapshot_momentum'
    : technicals.ema9 > technicals.ema21 && technicals.return1h > 0 ? 'confirmed_trend_continuation'
      : 'confirmed_technical_momentum_other';
  const hour = new Date(now).getUTCHours();
  const timeBucketUtc = `${String(Math.floor(hour / 6) * 6).padStart(2, '0')}-${String(Math.floor(hour / 6) * 6 + 5).padStart(2, '0')}`;
  const turnover = Number(asset.volume24h);
  const reportedTurnover24hUsd = Number.isFinite(turnover) && turnover >= 0 ? turnover : null;
  const reportedTurnoverCohort = reportedTurnover24hUsd === null ? 'unknown'
    : reportedTurnover24hUsd < 1_000_000 ? 'under_1m_usd'
      : reportedTurnover24hUsd < 10_000_000 ? '1m_to_10m_usd'
        : reportedTurnover24hUsd < 100_000_000 ? '10m_to_100m_usd' : '100m_plus_usd';
  const providerCountValue = asset.marketData?.providerCount;
  const providerCountAtObservation = providerCountValue == null || providerCountValue === '' || typeof providerCountValue === 'boolean'
    ? null : Number.isFinite(Number(providerCountValue)) ? Number(providerCountValue) : null;
  const eventRisk = asset.marketData?.eventRisk || {};
  const catalystEvents = Array.isArray(eventRisk.events) ? eventRisk.events : [];
  const category = (field) => {
    if (!catalystEvents.length) return 'none';
    const values = [...new Set(catalystEvents.map((event) => String(event?.[field] || 'unknown')))].sort();
    return values.length === 1 ? values[0] : 'multiple';
  };
  const manualEventStatus = settings.eventVetoEnabled === false ? 'disabled'
    : eventRisk.blocked ? 'active_block'
      : eventRisk.caution ? 'active_caution'
        : eventRisk.observe ? 'active_observe'
          : catalystEvents.length ? 'active_other' : 'no_active_manual_event';
  return {
    setupFamily, timeBucketUtc, reportedTurnover24hUsd, reportedTurnoverCohort, manualEventStatus,
    manualCatalystType: category('eventType'), manualCatalystDirection: category('direction'),
    manualCatalystExpectedness: category('expectedness'), manualCatalystHorizon: category('horizon'),
    manualCatalystImpact: category('impact'),
    providerCountAtObservation,
    productionBundleId: String(registry.production?.id || 'deterministic_only').slice(0, 100),
    metaModelId: String(registry.production?.meta?.id || 'inactive').slice(0, 100),
    outcomeModelId: String(registry.production?.outcomes?.id || 'inactive').slice(0, 100)
  };
}
