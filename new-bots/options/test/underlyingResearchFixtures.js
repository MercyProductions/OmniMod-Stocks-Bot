export const OPEN = Date.parse('2026-10-02T13:30:00Z');
export const NOW = Date.parse('2026-10-02T14:00:05Z');
export function researchBars({ count = 30, direction = 'long', crossIndex = count - 1, crossVolume = 2000 } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const c = i >= crossIndex ? (direction === 'long' ? 100.4 : 99.6) : 100;
    return { t: new Date(OPEN + i * 60000).toISOString(), o: 100, h: Math.max(100.2, c + 0.1),
      l: Math.min(99.8, c - 0.1), c, v: i === crossIndex ? crossVolume : 1000, vw: (100 + c) / 2 };
  });
}
export function researchInput(overrides = {}) {
  return { symbol: 'FRESH', assetId: 'fixture-id-FRESH', bars: researchBars(),
    quote: { bp: 100.39, ap: 100.41, bs: 10, as: 10, t: new Date(NOW).toISOString() },
    sessionOpen: new Date(OPEN).toISOString(), sessionClose: '2026-10-02T20:00:00Z', now: NOW, feed: 'iex', ...overrides };
}
export function researchDiscovery(symbols = ['FRESH']) {
  return { diagnostics: { version: 'options-independent-underlyings-v1', status: 'screen_complete', feed: 'iex', marketOpen: true,
    sessionOpen: new Date(OPEN).toISOString(), sessionClose: '2026-10-02T20:00:00Z' },
  shortlist: symbols.map((symbol) => ({ symbol, assetId: 'fixture-id-' + symbol, quoteAt: new Date(NOW - 5000).toISOString() })) };
}
