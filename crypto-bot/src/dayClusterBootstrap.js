/** Descriptive percentile bootstrap of mean trade R, resampling whole UTC signal-day clusters. */
export function bootstrapDayClusterExpectancy(trades, { replicates = 2_000, seed = 1 } = {}) {
  if (!Array.isArray(trades)) throw new TypeError('trades must be an array.');
  if (!Number.isInteger(replicates) || replicates < 100 || replicates > 100_000) throw new RangeError('replicates must be an integer from 100 through 100000.');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xFFFFFFFF) throw new RangeError('seed must be an unsigned 32-bit integer.');
  const days = new Map();
  for (const trade of trades) {
    const value = trade?.realizedR;
    const timestamp = typeof trade?.signalTime === 'number' ? trade.signalTime : Date.parse(trade?.signalTime);
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(timestamp)) {
      throw new TypeError('Each trade requires finite numeric realizedR and a valid signalTime.');
    }
    const day = new Date(timestamp).toISOString().slice(0, 10);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(value);
  }
  const clusters = [...days.values()];
  const totalTrades = clusters.reduce((sum, cluster) => sum + cluster.length, 0);
  const mean = totalTrades ? clusters.reduce((sum, cluster) => sum + cluster.reduce((a, b) => a + b, 0), 0) / totalTrades : null;
  if (clusters.length < 2) return { trades: totalTrades, signalDays: clusters.length, expectancyR: mean,
    lower95R: null, upper95R: null, replicates: 0, method: 'unavailable; fewer than two UTC signal-day clusters' };

  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
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
  const lower = estimates[Math.floor(0.025 * (replicates - 1))];
  const upper = estimates[Math.ceil(0.975 * (replicates - 1))];
  return { trades: totalTrades, signalDays: clusters.length, expectancyR: mean,
    lower95R: lower, upper95R: upper, replicates, method: 'percentile bootstrap; UTC signal-day clusters resampled with replacement; descriptive, no multiplicity adjustment' };
}
