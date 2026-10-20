import { createFuturesActivityScreen } from '../../src/futuresActivityScreen.js';
import { now, start, end, contract, directory, bar } from './activity.mjs';
export const iso = (t) => new Date(t).toISOString();
export function fixture(count = 1) {
  const contracts = Array.from({ length: count }, (_, i) => contract(i + 1, `NEW${i}`, {
    definitionTimestamp: iso(now - 3600000), providerCurrency: 'USD', providerTickSize: .25, providerContractMultiplier: 50 }));
  const dir = directory(contracts);
  const screen = createFuturesActivityScreen({ directory: dir, dataset: 'GLBX.MDP3', start, end, now, maxCandidates: 100 });
  for (const c of contracts) for (const m of [56, 57, 58, 59]) screen.add(bar(c, m));
  const result = screen.finish();
  const dayTrades = contracts.map((c) => ({ preparationStatus: 'operator_reviewed_paper_input',
    contract: { symbol: c.providerRawSymbol, providerSymbol: c.providerRawSymbol, providerRawSymbol: c.providerRawSymbol,
      providerRoot: c.providerRoot, providerDataset: c.providerDataset, providerPublisherId: c.providerPublisherId,
      providerInstrumentId: c.providerInstrumentId, providerExchange: c.providerExchange, expiry: c.expiry,
      contractId: `TEST:${c.providerRawSymbol}`, exposureKey: `NEWROOT:${c.providerRoot}`, activeContract: true, contractSpecVerified: true,
      specSource: 'https://example.test/spec', specVerifiedAt: iso(now - 1000), multiplier: 50, tickSize: .25, tickValueUsd: 12.5,
      initialMarginUsd: 2000, maintenanceMarginUsd: 1800,
      settlementReview: { source: 'https://example.test/spec', reviewedAt: iso(now - 1000), settlementType: 'cash_settled', lastTradeAt: c.expiry } },
    session: { marketDate: '2026-10-02', timeZone: 'America/Chicago', openTime: '2026-10-02T14:00:00Z', closeTime: '2026-10-02T21:00:00Z',
      source: 'https://example.test/session', reviewedAt: iso(now - 1000) },
    catalystReview: { status: 'clear', source: 'https://example.test/events', summary: 'Fixture only', reviewedAt: iso(now - 1000) },
    config: { roundTripFeesPerContract: 5, slippageReservePerContract: 2 },
  }));
  return { enabled: true, activity: { status: 'screen_complete', candidates: result.candidates, diagnostics: result.diagnostics, archive: { sha256: 'fixture-only' } },
    directory: dir, reviews: { status: 'loaded', sessionDate: '2026-10-02', dayTrades, sha256: 'test-review' },
    now, dayDataSource: 'databento-live', trendDataSource: 'databento-historical' };
}

