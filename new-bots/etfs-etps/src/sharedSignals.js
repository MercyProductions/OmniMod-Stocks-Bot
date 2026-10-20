import { isIntradayPrimaryResearch } from '../../shared/signalResearch.js';

/** Attach recent primary-bot research as context only; never use it as an ETF entry. */
export function attachPrimarySignalContext(trades, signals, { resolveExposureKey }) {
  if (!Array.isArray(trades) || !Array.isArray(signals) || typeof resolveExposureKey !== 'function') {
    throw new TypeError('Trades, signals, and an exposure resolver are required.');
  }
  return trades.map((trade) => {
    const exposureKey = resolveExposureKey(trade.symbol, trade.exposureKey);
    const related = signals.filter((signal) => {
      if (!['stocks', 'crypto', 'forex', 'futures', 'options'].includes(signal.owner) || signal.status !== 'active' || !isIntradayPrimaryResearch(signal)
        || signal.executable !== false || signal.paperOnly !== true) return false;
      const signalExposure = String(signal.exposureKey ?? '').trim().toUpperCase();
      if (signalExposure) return signalExposure === exposureKey;
      try { return resolveExposureKey(signal.symbol) === exposureKey; }
      catch { return false; }
    }).map((signal) => ({
      id: signal.id,
      owner: signal.owner,
      symbol: signal.symbol,
      direction: signal.direction,
      observedAt: signal.observedAt,
      strategyId: signal.strategyId,
      catalystContextStatus: signal.catalystContextStatus || 'unknown',
      catalystContext: (signal.catalystContext || []).slice(0, 2),
      executable: false,
      paperOnly: true,
    }));
    return { ...trade, exposureKey, primaryResearch: related };
  });
}
