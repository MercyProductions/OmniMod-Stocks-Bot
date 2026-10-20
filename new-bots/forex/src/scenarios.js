export function frameWatch(frame, { stale, tradeable, quoteValid, bid, ask, targetAtrMultiple }) {
  const up = frame.direction === 'up', down = frame.direction === 'down';
  if (stale || !tradeable || !quoteValid || (!up && !down) || !Number.isFinite(frame.atr14) || frame.atr14 <= 0) {
    const reason = stale ? 'Quote is stale.' : !tradeable ? 'Instrument is not tradeable.' : !quoteValid ? 'Bid/ask quote is invalid.' : 'Trend or ATR is unclear.';
    return { granularity: frame.granularity, bias: 'NO SETUP', reason };
  }
  const entryReference = up ? ask : bid;
  const invalidationPrice = entryReference + (up ? -1 : 1) * frame.atr14;
  const targetPrice = entryReference + (up ? 1 : -1) * frame.atr14 * targetAtrMultiple;
  const spread = ask - bid;
  return { granularity: frame.granularity, bias: up ? 'UPWARD PAPER WATCH' : 'DOWNWARD PAPER WATCH', entryReference,
    invalidationPrice, targetPrice, stopDistanceAtr: 1, targetDistanceAtr: targetAtrMultiple, grossRewardRisk: targetAtrMultiple,
    spreadToAtr: Number.isFinite(spread) && frame.atr14 > 0 ? Number((spread / frame.atr14).toFixed(4)) : null,
    method: 'EMA9/EMA21 trend filter with 1x ATR invalidation and configurable ATR target; heuristic, not a probability.' };
}
