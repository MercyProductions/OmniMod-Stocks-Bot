import { stockQuote } from '../../shared/fixtures/stockQuoteEvidence.js';
export const OPEN = Date.parse('2026-09-29T13:30:00Z');
export const NOW = OPEN + 25 * 300000 + 5000;
export function etfInput(symbol = 'SPY', at = NOW) {
  return { symbol, assetClass: 'etf', exposureKey: symbol,
    bars: Array.from({ length: 25 }, (_, i) => ({ time: new Date(OPEN + i * 300000).toISOString(),
      open: 100.1, high: i === 24 ? 100.95 : 100.2, low: 99.8, close: i === 24 ? 100.8 : 100.1, volume: i === 24 ? 2500 : 1000 })),
    quote: stockQuote(symbol, { bid: 100.8, ask: 100.81, time: new Date(at).toISOString(), quality: 'executable' }),
    session: { marketDate: '2026-09-29', openTime: OPEN, closeTime: OPEN + 390 * 60000, expectedBarsThroughNow: true,
      catalystReview: { status: 'clear', source: 'synthetic issuer review', summary: 'Synthetic clearance.', reviewedAt: new Date(NOW).toISOString() } },
    config: { roundTripFeesPerUnit: 0.01, slippageReservePerUnit: 0.01 } };
}
export const rawQuote = (at = NOW, overrides = {}) => ({ bp: 100.8, ap: 100.81, bs: 100000, as: 100000,
  bx: 'P', ax: 'P', z: 'B', c: ['R'], t: new Date(at).toISOString(), ...overrides });
export const portfolio = () => ({ accountEquity: 10000, realizedPnlToday: 0, openPositions: [], closedOrders: [] });
export const policy = (now = NOW) => ({ now, maxQuoteAgeMs: 15000, maxSpreadPct: 0.5, maxTradeRiskPct: 0.25,
  maxTotalOpenRiskPct: 1, maxGrossExposurePct: 200, maxDailyLossPct: 1, minRewardRisk: 1.5, emergencyStop: false });
