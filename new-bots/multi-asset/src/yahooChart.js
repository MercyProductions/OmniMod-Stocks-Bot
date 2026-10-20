const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';

export function normalizeChartBars(payload, { adjusted = false } = {}) {
  const result = payload?.chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error(payload?.chart?.error?.description || 'Chart response has no bars');
  const quote = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose;
  return result.timestamp.map((time, i) => ({
    time: Number(time) * 1000,
    open: Number(quote.open?.[i]), high: Number(quote.high?.[i]), low: Number(quote.low?.[i]),
    close: Number(adjusted && Number.isFinite(Number(adj?.[i])) ? adj[i] : quote.close?.[i]),
    volume: Number(quote.volume?.[i])
  })).filter((bar) => Number.isFinite(bar.time) && Number.isFinite(bar.close) && bar.close > 0);
}

export function summarizeDailyBars(bars) {
  if (!Array.isArray(bars) || bars.length < 22) throw new Error('At least 22 daily bars are required for the multi-asset summary');
  const closes = bars.map((bar) => bar.close);
  const returns = closes.slice(1).map((close, i) => (close / closes[i] - 1) * 100).filter(Number.isFinite);
  const recent = returns.slice(-20);
  const mean = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  const variance = recent.reduce((sum, value) => sum + (value - mean) ** 2, 0) / recent.length;
  return {
    return1dPct: Number(returns.at(-1).toFixed(4)),
    return5dPct: Number(((closes.at(-1) / closes.at(-6) - 1) * 100).toFixed(4)),
    volatility20dPct: Number((Math.sqrt(variance) * Math.sqrt(252)).toFixed(4))
  };
}

async function fetchChart(providerSymbol, interval, range, fetcher, metrics = [], clock = Date.now, permissionConfirmed = false) {
  if (permissionConfirmed !== true) throw new Error('Yahoo Chart access requires a documented permission attestation; this provider is disabled by default.');
  const url = `${CHART_URL}${encodeURIComponent(providerSymbol)}?${new URLSearchParams({ interval, range, includePrePost: 'false', events: 'div,splits' })}`;
  const startedAt = clock();
  let status = 0;
  try {
    const response = await fetcher(url, { headers: { 'User-Agent': 'Mozilla/5.0 OmniMod-MultiAssetResearch/0.1' }, signal: AbortSignal.timeout(15_000) });
    status = Number(response.status) || 0;
    if (!response.ok) throw new Error(`Chart provider HTTP ${status}`);
    const payload = await response.json();
    const result = { bars: normalizeChartBars(payload, { adjusted: interval === '1d' }), meta: payload.chart.result?.[0]?.meta || {} };
    metrics.push({ provider: 'Yahoo Chart public', operation: `chart-${interval}`, status, latencyMs: Math.max(0, clock() - startedAt) });
    return result;
  } catch (error) {
    const message = String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180);
    metrics.push({ provider: 'Yahoo Chart public', operation: `chart-${interval}`, status: Number(error.status) || status, latencyMs: Math.max(0, clock() - startedAt), error: message });
    throw error;
  }
}

export async function fetchYahooObservation(spec, { fetcher = fetch, now = Date.now(), metrics = [], clock = Date.now, permissionConfirmed = false } = {}) {
  const symbol = String(spec.symbol || '').trim();
  const providerSymbol = String(spec.providerSymbol || symbol).trim();
  if (!symbol || !providerSymbol) throw new Error('Both symbol and providerSymbol are required');
  const results = await Promise.allSettled([
    fetchChart(providerSymbol, '5m', '5d', fetcher, metrics, clock, permissionConfirmed),
    fetchChart(providerSymbol, '1d', '1y', fetcher, metrics, clock, permissionConfirmed)
  ]);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  const [intraday, daily] = results.map((result) => result.value);
  const latest = intraday.bars.at(-1);
  if (!latest || daily.bars.length < 22) throw new Error('Provider returned insufficient current or daily bars');
  const ageMinutes = (now - latest.time) / 60000;
  const summary = summarizeDailyBars(daily.bars);
  const providerTimeZone = intraday.meta.exchangeTimezoneName || daily.meta.exchangeTimezoneName || null;
  return {
    symbol, providerSymbol, assetClass: spec.assetClass || 'unspecified', price: latest.close,
    ...(spec.leverageReset ? { leverageReset: spec.leverageReset } : {}),
    ...(spec.instrumentNote ? { instrumentNote: String(spec.instrumentNote) } : {}),
    ...summary, observedAt: new Date(latest.time).toISOString(), providerTimeZone,
    source: 'Yahoo Chart (public delayed/unofficial)', delayed: true,
    ...(Number.isFinite(Number(spec.maxAgeMinutes)) ? { maxAgeMinutes: Number(spec.maxAgeMinutes) } : {}),
    providerAgeMinutes: Number(ageMinutes.toFixed(1))
  };
}

export async function fetchYahooUniverse(universe, { concurrency = 4, fetcher = fetch, now = Date.now(), metrics = [], clock = Date.now, permissionConfirmed = false } = {}) {
  const output = new Array(universe.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), universe.length) }, async () => {
    while (next < universe.length) {
      const index = next++;
      try { output[index] = await fetchYahooObservation(universe[index], { fetcher, now, metrics, clock, permissionConfirmed }); }
      catch (error) {
        const spec = universe[index];
        output[index] = { symbol: spec.symbol, providerSymbol: spec.providerSymbol || spec.symbol, assetClass: spec.assetClass || 'unspecified', source: 'Yahoo Chart (public delayed/unofficial)', delayed: true, observedAt: null, providerError: error.message };
      }
    }
  }));
  return output;
}
