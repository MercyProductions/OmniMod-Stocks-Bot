export const NOW = Date.parse('2026-10-02T15:00:00Z');
export const iso = at => new Date(at).toISOString();
export function fixture(direction = 'long') {
  const review = { status: 'clear', source: 'manual-review', summary: 'Synthetic catalyst clearance.', reviewedAt: iso(NOW) };
  const signal = { underlyingSymbol: 'SPY', direction, underlyingPrice: 100,
    underlyingTarget: direction === 'long' ? 104 : 96, underlyingStop: direction === 'long' ? 99 : 101,
    entryLow: 99.5, entryHigh: 100.5, observedAt: iso(NOW), sessionDate: '2026-10-02',
    sessionClose: '2026-10-02T20:00:00.000Z', sessionOpen: true, catalystReview: review,
    underlyingQuote: { symbol: 'SPY', bid: 99.99, ask: 100.01, time: iso(NOW), quality: 'executable' },
    optionAssignmentReview: { status: 'clear', source: 'https://issuer.example/dividends', summary: 'Synthetic dividend clearance.',
      reviewedAt: iso(NOW), reviewedThrough: '2026-10-06', nextExDividendDate: null } };
  const chain = { expiry: '2026-10-06', quoteQuality: 'executable', options: [100, direction === 'long' ? 103 : 97].map((strike, i) => ({
    symbol: `SPY261006${direction === 'long' ? 'C' : 'P'}${String(strike * 1000).padStart(8, '0')}`,
    underlying: 'SPY', root: 'SPY', type: direction === 'long' ? 'call' : 'put', strike, expiry: '2026-10-06', multiplier: 100,
    bid: i ? 1 : 2, ask: i ? 1.05 : 2.05, time: iso(NOW), quoteQuality: 'executable', volume: 100, openInterest: 500,
  })) };
  return { now: NOW, signal, chain, config: { feePerContractRoundTrip: 0.65, slippageReservePerContract: 0.25 } };
}
export function fillQuote(row, at = NOW + 1000) {
  return { bid: 0.95, ask: 1.05, time: iso(at), quality: 'executable', optionEntryEvidence: {
    version: 'option-entry-evidence-v1', sessionDate: row.signal.sessionDate, sessionClose: row.signal.sessionClose,
    underlyingQuote: { ...row.signal.underlyingQuote, symbol: row.signal.underlyingSymbol, time: iso(at), bidTime: iso(at), askTime: iso(at) },
    legs: row.chain.options.map(leg => ({ ...leg, time: iso(at), bidTime: iso(at), askTime: iso(at) })),
    catalyst: { source: 'manual', checkedAt: iso(at), review: row.signal.catalystReview },
  } };
}
