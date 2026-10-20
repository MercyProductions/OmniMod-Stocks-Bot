const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value)));

function average(values) {
  const rows = values.filter(Number.isFinite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

export function normalizeCandles(candles = []) {
  const byTime = new Map();
  for (const row of candles) {
    const time = finite(row?.time, NaN);
    const open = finite(row?.open, NaN);
    const high = finite(row?.high, NaN);
    const low = finite(row?.low, NaN);
    const close = finite(row?.close, NaN);
    const volume = Math.max(0, finite(row?.volume));
    if (![time, open, high, low, close].every(Number.isFinite) || time <= 0 || Math.min(open, high, low, close) <= 0
      || high < Math.max(open, close) || low > Math.min(open, close) || high < low) continue;
    byTime.set(time, { time, open, high, low, close, volume });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export function emaSeries(values = [], period = 14) {
  const rows = values.map((value) => finite(value, NaN)).filter(Number.isFinite);
  if (!rows.length) return [];
  const multiplier = 2 / (Math.max(1, period) + 1);
  const result = [rows[0]];
  for (let index = 1; index < rows.length; index += 1) {
    result.push(rows[index] * multiplier + result[index - 1] * (1 - multiplier));
  }
  return result;
}

export function rsi(values = [], period = 14) {
  const rows = values.map(Number).filter(Number.isFinite);
  if (rows.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = rows[index] - rows[index - 1];
    gains += Math.max(0, change);
    losses += Math.max(0, -change);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let index = period + 1; index < rows.length; index += 1) {
    const change = rows[index] - rows[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period;
  }
  if (averageLoss === 0) return averageGain > 0 ? 100 : 50;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

export function atr(candles = [], period = 14) {
  const rows = normalizeCandles(candles);
  if (rows.length < 2) return 0;
  const ranges = rows.slice(1).map((row, index) => Math.max(
    row.high - row.low,
    Math.abs(row.high - rows[index].close),
    Math.abs(row.low - rows[index].close)
  ));
  let value = average(ranges.slice(0, Math.min(period, ranges.length)));
  for (let index = period; index < ranges.length; index += 1) value = (value * (period - 1) + ranges[index]) / period;
  return value;
}

export function adx(candles = [], period = 14) {
  const rows = normalizeCandles(candles);
  if (rows.length < period * 2 + 1) return 0;
  const trueRanges = [];
  const plusDm = [];
  const minusDm = [];
  for (let index = 1; index < rows.length; index += 1) {
    const up = rows[index].high - rows[index - 1].high;
    const down = rows[index - 1].low - rows[index].low;
    trueRanges.push(Math.max(
      rows[index].high - rows[index].low,
      Math.abs(rows[index].high - rows[index - 1].close),
      Math.abs(rows[index].low - rows[index - 1].close)
    ));
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  let smoothTr = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0);
  let smoothPlus = plusDm.slice(0, period).reduce((sum, value) => sum + value, 0);
  let smoothMinus = minusDm.slice(0, period).reduce((sum, value) => sum + value, 0);
  const dx = [];
  for (let index = period; index < trueRanges.length; index += 1) {
    smoothTr = smoothTr - smoothTr / period + trueRanges[index];
    smoothPlus = smoothPlus - smoothPlus / period + plusDm[index];
    smoothMinus = smoothMinus - smoothMinus / period + minusDm[index];
    const plusDi = smoothTr > 0 ? 100 * smoothPlus / smoothTr : 0;
    const minusDi = smoothTr > 0 ? 100 * smoothMinus / smoothTr : 0;
    dx.push(plusDi + minusDi > 0 ? 100 * Math.abs(plusDi - minusDi) / (plusDi + minusDi) : 0);
  }
  if (dx.length < period) return average(dx);
  let value = average(dx.slice(0, period));
  for (let index = period; index < dx.length; index += 1) value = (value * (period - 1) + dx[index]) / period;
  return value;
}

function percentReturn(closes, bars) {
  if (closes.length <= bars || closes.at(-1 - bars) <= 0) return 0;
  return (closes.at(-1) / closes.at(-1 - bars) - 1) * 100;
}

function volumeZScore(volumes, period = 20) {
  if (volumes.length < period + 1) return 0;
  const baseline = volumes.slice(-period - 1, -1);
  const deviation = standardDeviation(baseline);
  return deviation > 0 ? (volumes.at(-1) - average(baseline)) / deviation : 0;
}

export function analyzeCandles(candles = []) {
  const rows = normalizeCandles(candles);
  const closes = rows.map((row) => row.close);
  const volumes = rows.map((row) => row.volume);
  if (rows.length < 2) {
    return {
      dataSufficient: false, sampleSize: rows.length, technicalScore: 0, latestPrice: closes.at(-1) || 0,
      atr: 0, atrPct: 0, rsi14: 50, adx14: 0, ema9: 0, ema21: 0, ema50: 0,
      macd: 0, macdSignal: 0, macdHistogram: 0, macdHistogramSlope: 0, volumeZScore: 0,
      return15m: 0, return1h: 0, return4h: 0, candleConsistency: 0, distanceFromEmaAtr: 0,
      chasePenalty: 0, reasons: ['Insufficient candle history']
    };
  }

  const ema9Series = emaSeries(closes, 9);
  const ema21Series = emaSeries(closes, 21);
  const ema50Series = emaSeries(closes, 50);
  const ema12Series = emaSeries(closes, 12);
  const ema26Series = emaSeries(closes, 26);
  const macdSeries = ema12Series.map((value, index) => value - ema26Series[index]);
  const signalSeries = emaSeries(macdSeries, 9);
  const histogram = macdSeries.map((value, index) => value - signalSeries[index]);
  const latestPrice = closes.at(-1);
  const atrValue = atr(rows, 14);
  const atrPct = latestPrice > 0 ? atrValue / latestPrice * 100 : 0;
  const rsi14 = rsi(closes, 14);
  const adx14 = adx(rows, 14);
  const ema9 = ema9Series.at(-1);
  const ema21 = ema21Series.at(-1);
  const ema50 = ema50Series.at(-1);
  const macd = macdSeries.at(-1);
  const macdSignal = signalSeries.at(-1);
  const macdHistogram = histogram.at(-1);
  const macdHistogramSlope = macdHistogram - (histogram.at(-2) || 0);
  const return15m = percentReturn(closes, 1);
  const return1h = percentReturn(closes, 4);
  const return4h = percentReturn(closes, 16);
  const consistencyWindow = rows.slice(-12);
  const candleConsistency = consistencyWindow.length
    ? consistencyWindow.filter((row) => row.close > row.open).length / consistencyWindow.length * 100 : 0;
  const zScore = volumeZScore(volumes);
  const distanceFromEmaAtr = atrValue > 0 ? (latestPrice - ema21) / atrValue : 0;

  let technicalScore = 20;
  const reasons = [];
  if (ema9 > ema21) { technicalScore += 16; reasons.push('EMA 9 is above EMA 21'); } else technicalScore -= 8;
  if (ema21 > ema50) { technicalScore += 16; reasons.push('EMA 21 is above EMA 50'); } else technicalScore -= 8;
  if (latestPrice > ema21) technicalScore += 10;
  if (rsi14 >= 52 && rsi14 <= 68) { technicalScore += 14; reasons.push('RSI is in the constructive zone'); }
  else if (rsi14 >= 45 && rsi14 < 52) technicalScore += 6;
  else if (rsi14 > 75) technicalScore -= 12;
  else if (rsi14 < 38) technicalScore -= 10;
  if (macdHistogram > 0) { technicalScore += 10; reasons.push('MACD momentum is positive'); } else technicalScore -= 6;
  if (macdHistogramSlope > 0) technicalScore += 5;
  if (return1h > 0) technicalScore += 5; else technicalScore -= 5;
  if (return4h > 0) technicalScore += 6; else technicalScore -= 6;
  if (candleConsistency >= 58 && candleConsistency <= 83) technicalScore += 5;
  if (zScore >= 0.5 && zScore <= 3.5) { technicalScore += 5; reasons.push('Volume is above its recent baseline'); }
  if (adx14 >= 18 && adx14 <= 48) technicalScore += 4;

  const chasePenalty = clamp(
    Math.max(0, rsi14 - 72) * 1.2 + Math.max(0, distanceFromEmaAtr - 2.2) * 6 + Math.max(0, return1h - 3) * 2,
    0, 24
  );
  technicalScore = clamp(technicalScore - chasePenalty, 0, 100);

  return {
    dataSufficient: rows.length >= 80 && rows.slice(-79).every((row, index) => row.time - rows[rows.length - 80 + index].time === 900_000),
    sampleSize: rows.length, latestPrice,
    technicalScore, atr: atrValue, atrPct, rsi14, adx14, ema9, ema21, ema50,
    macd, macdSignal, macdHistogram, macdHistogramSlope, volumeZScore: zScore,
      return15m, return1h, return4h, candleConsistency, distanceFromEmaAtr, chasePenalty, reasons: reasons.slice(0, 4)
  };
}

export function classifyMarketRegime(bitcoinTechnicals, bitcoinSnapshot = {}) {
  const t = bitcoinTechnicals || {};
  if (!t.dataSufficient) {
    const change24h = finite(bitcoinSnapshot.change24h);
    return {
      key: change24h < -5 ? 'risk_off' : 'neutral', label: change24h < -5 ? 'Risk-off' : 'Neutral',
      score: change24h < -5 ? 28 : 50, allowNewLongs: change24h >= -5,
      reason: 'BTC candle history was unavailable; using the broad 24h move only.'
    };
  }
  let score = 50;
  if (t.ema9 > t.ema21) score += 12; else score -= 12;
  if (t.ema21 > t.ema50) score += 14; else score -= 14;
  if (t.macdHistogram > 0) score += 8; else score -= 8;
  if (t.return4h > 0) score += 8; else score -= 8;
  if (t.rsi14 >= 45 && t.rsi14 <= 72) score += 6;
  if (t.rsi14 < 38 || t.rsi14 > 80) score -= 8;
  score = clamp(score, 0, 100);
  const key = score >= 66 ? 'risk_on' : score < 38 ? 'risk_off' : 'neutral';
  return {
    key, label: key === 'risk_on' ? 'Risk-on' : key === 'risk_off' ? 'Risk-off' : 'Neutral', score,
    allowNewLongs: score >= 38,
    reason: key === 'risk_on'
      ? 'BTC confirms a constructive EMA/MACD regime.'
      : key === 'risk_off' ? 'BTC trend and momentum disagree with new long exposure.' : 'BTC conditions are mixed; require stronger asset confirmation.'
  };
}
