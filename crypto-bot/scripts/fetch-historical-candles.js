import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { retryPlan } from '../src/retryPolicy.js';

const API_ROOT = 'https://data-api.binance.vision/api/v3/klines';
const BAR_MS = 15 * 60_000;
const PAGE_LIMIT = 1000;
const HARD_BAR_CAP = 20_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  return Object.fromEntries(argv.map((item) => {
    const [key, ...parts] = item.replace(/^--/, '').split('=');
    return [key, parts.length ? parts.join('=') : 'true'];
  }));
}

function timestamp(value, label) {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new TypeError(`--${label} must be an ISO timestamp.`);
  return result;
}

export async function fetchBinanceSpotCandles({ symbol, startTime, endTime, maxBars = 6000,
  fetcher = fetch, now = Date.now(), pageDelayMs = 250, sleepFn = sleep } = {}) {
  const market = String(symbol || '').trim().toUpperCase();
  const start = Number(startTime);
  const end = Number(endTime);
  const cap = Number(maxBars);
  if (!/^[A-Z0-9]{5,20}$/.test(market)) throw new TypeError('A valid Binance Spot market symbol such as BTCUSDT is required.');
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || start % BAR_MS || end % BAR_MS) {
    throw new TypeError('startTime/endTime must be increasing UTC epoch milliseconds aligned to 15-minute boundaries.');
  }
  if (!Number.isInteger(cap) || cap < 1 || cap > HARD_BAR_CAP) throw new RangeError(`maxBars must be an integer from 1 to ${HARD_BAR_CAP}.`);
  if (!Number.isFinite(now) || pageDelayMs < 0 || pageDelayMs > 10_000) throw new TypeError('Invalid clock or page delay.');
  const expectedBars = Math.ceil((end - start) / BAR_MS);
  if (expectedBars > cap) throw new RangeError(`Requested range needs ${expectedBars} bars, above maxBars=${cap}; use a shorter range or a higher explicit cap.`);

  const rows = new Map();
  const requests = [];
  let cursor = start;
  while (cursor < end) {
    const pageEnd = Math.min(end - 1, cursor + PAGE_LIMIT * BAR_MS - 1);
    const url = new URL(API_ROOT);
    url.search = new URLSearchParams({ symbol: market, interval: '15m', startTime: String(cursor), endTime: String(pageEnd), limit: String(PAGE_LIMIT) });
    let payload;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetcher(url, { headers: { Accept: 'application/json' } });
        requests.push({ status: response.status, attempt: attempt + 1 });
        if (response.status === 429 || response.status >= 500) {
          if (attempt < 2) {
            const plan = retryPlan(response.headers?.get?.('retry-after'), attempt, {
              serverDateHeader: response.headers?.get?.('date'), maxRetryDelayMs: 10_000,
            });
            if (!plan.retry) throw new Error(`Binance returned HTTP ${response.status}; retry deferred because Retry-After requests ${plan.delayMs}ms, above the retry wait limit.`);
            await sleepFn(plan.delayMs);
            continue;
          }
        }
        if (!response.ok) throw new Error(`Binance returned HTTP ${response.status}.`);
        payload = await response.json();
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2 && !/HTTP \d{3}/.test(String(error?.message || ''))) { await sleepFn((attempt + 1) * 500); continue; }
        throw error;
      }
    }
    if (!Array.isArray(payload)) throw lastError || new TypeError('Binance kline response was not an array.');
    if (!payload.length) break;
    let lastOpen = -1;
    for (const candle of payload) {
      if (!Array.isArray(candle) || candle.length < 6) continue;
      const openTime = Number(candle[0]);
      const closeTime = Number(candle[6]);
      const values = candle.slice(1, 6).map(Number);
      const [open, high, low, close, volume] = values;
      if (!Number.isFinite(openTime) || openTime % BAR_MS !== 0 || openTime < start || openTime >= end || openTime + BAR_MS > now || closeTime + 1 > now
        || !values.every(Number.isFinite) || [open, high, low, close].some((price) => price <= 0) || volume < 0
        || high < Math.max(open, close) || low > Math.min(open, close) || high < low) continue;
      rows.set(openTime, { time: openTime, open: values[0], high: values[1], low: values[2], close: values[3], volume: values[4],
        symbol: market.replace(/USDT$/, ''), pair: market, provider: 'Binance Spot' });
      lastOpen = Math.max(lastOpen, openTime);
    }
    if (lastOpen < cursor) break;
    cursor = lastOpen + BAR_MS;
    if (cursor < end && rows.size < cap) await sleepFn(pageDelayMs);
  }
  const candles = [...rows.values()].sort((a, b) => a.time - b.time);
  const missingBarSlots = Math.max(0, expectedBars - candles.length);
  return { candles, diagnostics: { provider: 'Binance Spot public klines', market: market, interval: '15m', startTime: start,
    endTimeExclusive: end, expectedBars, returnedBars: candles.length, missingBarSlots, requestAttempts: requests,
    complete: candles.length === expectedBars, firstBar: candles[0]?.time ?? null, lastBar: candles.at(-1)?.time ?? null,
    observationsAreOHLCVNotExecutableQuotes: true } };
}

export async function writeHistoricalDataset({ symbol, start, end, out, maxBars, fetcher = fetch, now = Date.now(), pageDelayMs = 250 } = {}) {
  const startMs = timestamp(start, 'start');
  const endMs = timestamp(end, 'end');
  const endAligned = Math.floor(endMs / BAR_MS) * BAR_MS;
  const result = await fetchBinanceSpotCandles({ symbol, startTime: Math.ceil(startMs / BAR_MS) * BAR_MS,
    endTime: endAligned, maxBars, fetcher, now, pageDelayMs });
  if (!result.candles.length) throw new Error('No completed candles were returned for the requested range.');
  const output = path.resolve(out || '');
  if (!out) throw new Error('Pass --out=<dataset.ndjson>.');
  await fs.mkdir(path.dirname(output), { recursive: true });
  const serialized = `${result.candles.map((row) => JSON.stringify(row)).join('\n')}\n`;
  await fs.writeFile(output, serialized, { flag: 'wx' });
  const manifest = { schemaVersion: 1, fetchedAt: new Date(now).toISOString(), source: 'Binance Spot public REST klines',
    sourceUrl: API_ROOT, symbol: String(symbol).toUpperCase(), interval: '15m', startRequested: start, endRequestedExclusive: end,
    dataset: path.basename(output), sha256: createHash('sha256').update(serialized).digest('hex'), ...result.diagnostics,
    limitations: ['OHLCV bars are not executable bid/ask quotes or observed fills.', 'Current instrument universe can introduce survivorship bias.', 'This public dataset does not establish commercial redistribution rights or provider entitlement.', 'Backtest results are exploratory and do not establish profitability.'] };
  const manifestPath = `${output}.manifest.json`;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return { output, manifestPath, ...manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await writeHistoricalDataset({ symbol: args.symbol, start: args.start, end: args.end, out: args.out,
      maxBars: args.maxBars === undefined ? 6000 : Number(args.maxBars), pageDelayMs: args.pageDelayMs === undefined ? 250 : Number(args.pageDelayMs) });
    console.log(JSON.stringify(result, null, 2));
    if (!result.complete) process.exitCode = 2;
  } catch (error) { console.error(`Historical data fetch failed: ${String(error?.message || error).slice(0, 240)}`); process.exitCode = 1; }
}
