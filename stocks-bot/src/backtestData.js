function normalizeRows(rows, name, dateKey, marketMinute, includeMarketMinute = false) {
  if (!Array.isArray(rows)) throw new TypeError(`${name} bars must be an array.`);
  let previous = -Infinity;
  return rows.map((row, index) => {
    const timestamp = Number(row?.timestamp);
    const values = ['open', 'high', 'low', 'close'].map((key) => Number(row?.[key]));
    const volume = Number(row?.volume ?? 0);
    if (!Number.isSafeInteger(timestamp) || timestamp <= previous
      || !values.every((value) => Number.isFinite(value) && value > 0)
      || values[1] < Math.max(values[0], values[3]) || values[2] > Math.min(values[0], values[3])
      || values[2] > values[1] || !Number.isFinite(volume) || volume < 0) {
      throw new TypeError(`${name} bar ${index} is malformed or out of chronological order.`);
    }
    previous = timestamp;
    return { timestamp, open: values[0], high: values[1], low: values[2], close: values[3], volume,
      session: dateKey(timestamp), ...(includeMarketMinute ? { minute: marketMinute(timestamp) } : {}) };
  });
}

function normalizeSeries(symbol, series, dateKey, marketMinute) {
  if (!series || typeof series !== 'object') throw new TypeError(`${symbol} dataset is missing.`);
  const intraday = normalizeRows(series.intraday, `${symbol} intraday`, dateKey, marketMinute, true)
    .filter((bar) => bar.minute >= 570 && bar.minute < 960);
  const daily = normalizeRows(series.daily, `${symbol} daily`, dateKey, marketMinute);
  return [symbol, { intraday, daily }];
}

/** Load a pinned local universe without invoking the provider callback, or use the provider callback when omitted. */
export async function loadBacktestUniverse(symbols, { localData = null, fetchSymbol, dateKey, marketMinute } = {}) {
  if (typeof dateKey !== 'function' || typeof marketMinute !== 'function') throw new TypeError('Backtest timestamp formatters are required.');
  if (localData != null && (!localData.symbols || typeof localData.symbols !== 'object' || Array.isArray(localData.symbols))) {
    throw new TypeError('Local stock backtest data must contain a symbols object.');
  }
  if (localData == null && typeof fetchSymbol !== 'function') throw new TypeError('A provider loader is required when local data is not supplied.');
  const unique = [...new Set(symbols.map((symbol) => String(symbol).trim().toUpperCase()))];
  const rows = await Promise.all(unique.map(async (symbol) => {
    const series = localData == null ? await fetchSymbol(symbol) : localData.symbols[symbol];
    return normalizeSeries(symbol, series, dateKey, marketMinute);
  }));
  return new Map(rows);
}
