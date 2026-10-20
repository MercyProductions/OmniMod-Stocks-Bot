import { hasExplicitFiniteAmount } from './strategyConfig.js';

const roundMoney = (value) => Number(value.toFixed(2));

/** Closed-trade order is necessary for drawdown and consecutive-loss claims. */
export function inspectClosedTradeSequence(rows = []) {
  const closed = rows.filter((row) => row?.status === 'closed');
  const observed = closed.map((row) => ({ pnl: row?.realizedPnlUsd,
    time: typeof row?.closedAt === 'string' ? Date.parse(row.closedAt) : NaN }))
    .filter((row) => hasExplicitFiniteAmount(row.pnl) && Number.isFinite(row.time));
  const unavailable = (status) => ({ status, observationCount: observed.length,
    maximumDrawdownUsd: null, currentDrawdownUsd: null,
    maximumConsecutiveLosses: null, currentConsecutiveLosses: null });
  if (!closed.length) return unavailable('no_closed_trades');
  if (observed.length !== closed.length) return unavailable('incomplete_close_sequence');
  observed.sort((a, b) => a.time - b.time);
  if (observed.some((row, index) => index && row.time === observed[index - 1].time))
    return unavailable('ambiguous_close_order');
  let cumulative = 0, peak = 0, maximumDrawdown = 0;
  let lossStreak = 0, maximumLossStreak = 0;
  for (const row of observed) {
    const pnl = Number(row.pnl);
    cumulative += pnl;
    peak = Math.max(peak, cumulative);
    maximumDrawdown = Math.max(maximumDrawdown, peak - cumulative);
    lossStreak = pnl < 0 ? lossStreak + 1 : 0;
    maximumLossStreak = Math.max(maximumLossStreak, lossStreak);
  }
  return { status: 'complete', observationCount: observed.length,
    maximumDrawdownUsd: roundMoney(maximumDrawdown), currentDrawdownUsd: roundMoney(peak - cumulative),
    maximumConsecutiveLosses: maximumLossStreak, currentConsecutiveLosses: lossStreak };
}
