/** Percentile bootstrap of mean risk-normalized return, resampling whole market-session days. */
export function bootstrapSessionExpectancy(orders, { replicates = 2_000, seed = 1 } = {}) {
  if (!Array.isArray(orders)) throw new TypeError('orders must be an array.');
  if (!Number.isInteger(replicates) || replicates < 100 || replicates > 100_000) throw new RangeError('replicates must be an integer from 100 through 100000.');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xFFFFFFFF) throw new RangeError('seed must be an unsigned 32-bit integer.');
  const days = new Map();
  let excluded = 0;
  for (const order of orders) {
    const day = String(order?.sessionDate ?? '');
    const risk = hasExplicitPositiveFiniteAmount(order?.riskUsd) ? Number(order.riskUsd) : NaN;
    const pnl = hasExplicitFiniteAmount(order?.realizedPnlUsd) ? Number(order.realizedPnlUsd) : NaN;
    const midnight = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN;
    if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== day
      || !Number.isFinite(risk) || risk <= 0 || !Number.isFinite(pnl)) { excluded += 1; continue; }
    const value = pnl / risk;
    if (!Number.isFinite(value)) { excluded += 1; continue; }
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(value);
  }
  const clusters = [...days.values()];
  const tradeCount = clusters.reduce((sum, cluster) => sum + cluster.length, 0);
  const expectancyR = tradeCount ? clusters.reduce((sum, cluster) => sum + cluster.reduce((a, b) => a + b, 0), 0) / tradeCount : null;
  const base = { trades: tradeCount, excluded, sessionDays: clusters.length, expectancyR };
  if (clusters.length < 2) return { ...base, lower95R: null, upper95R: null, replicates: 0,
    method: 'unavailable; fewer than two market-session clusters' };

  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; return state / 0x1_0000_0000; };
  const estimates = new Array(replicates);
  for (let sample = 0; sample < replicates; sample += 1) {
    let sum = 0, count = 0;
    for (let draw = 0; draw < clusters.length; draw += 1) {
      const cluster = clusters[Math.floor(random() * clusters.length)];
      for (const value of cluster) { sum += value; count += 1; }
    }
    estimates[sample] = sum / count;
  }
  estimates.sort((a, b) => a - b);
  return { ...base, lower95R: estimates[Math.floor(0.025 * (replicates - 1))],
    upper95R: estimates[Math.ceil(0.975 * (replicates - 1))], replicates,
    method: 'percentile bootstrap; entire market-session entry-date clusters resampled with replacement; descriptive, no multiplicity adjustment' };
}
import { hasExplicitFiniteAmount, hasExplicitPositiveFiniteAmount } from './strategyConfig.js';

