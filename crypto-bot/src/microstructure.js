import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDataDir, paths } from './storage.js';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value)));
const safe = (value) => String(value || 'unknown').replace(/[^0-9a-z_-]/gi, '-').toLowerCase();
const monthKey = (date = new Date()) => new Date(date).toISOString().slice(0, 7);
let writeQueue = Promise.resolve();

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function bookMetrics(bids = [], asks = [], midpoint = 0) {
  const notional = (rows, withinPct = Infinity) => rows.reduce((sum, level) => {
    const price = finite(level?.[0]);
    const size = finite(level?.[1]);
    if (!(price > 0 && size > 0)) return sum;
    if (midpoint > 0 && Math.abs(price / midpoint - 1) * 100 > withinPct) return sum;
    return sum + price * size;
  }, 0);
  const bidUsd = notional(bids);
  const askUsd = notional(asks);
  const bidDepth1PctUsd = notional(bids, 1);
  const askDepth1PctUsd = notional(asks, 1);
  return {
    bidUsd, askUsd, depthUsd1Pct: bidDepth1PctUsd + askDepth1PctUsd,
    depthImbalance: bidUsd + askUsd > 0 ? (bidUsd - askUsd) / (bidUsd + askUsd) : 0
  };
}

export class MicrostructureAccumulator {
  constructor(symbol, windowMs = 5 * 60_000) {
    this.symbol = String(symbol || '').toUpperCase();
    this.windowMs = windowMs;
    this.quotes = [];
    this.trades = [];
    this.books = new Map();
  }

  prune(now = Date.now()) {
    const cutoff = now - this.windowMs;
    this.quotes = this.quotes.filter((row) => row.time >= cutoff);
    this.trades = this.trades.filter((row) => row.time >= cutoff);
  }

  recordQuote(quote, now = Date.now()) {
    const bid = finite(quote.bid);
    const ask = finite(quote.ask);
    if (!(bid > 0 && ask >= bid)) return;
    this.quotes.push({ time: now, provider: quote.provider, bid, ask, bidSize: finite(quote.bidSize), askSize: finite(quote.askSize) });
    this.prune(now);
  }

  recordTrade(trade, now = Date.now()) {
    const price = finite(trade.price);
    const size = Math.max(0, finite(trade.size));
    if (!(price > 0 && size > 0)) return;
    this.trades.push({ time: now, provider: trade.provider, price, size, side: trade.side === 'sell' ? 'sell' : 'buy' });
    this.prune(now);
  }

  recordBook(book, now = Date.now()) {
    const bids = Array.isArray(book.bids) ? book.bids : [];
    const asks = Array.isArray(book.asks) ? book.asks : [];
    if (!bids.length || !asks.length) return;
    this.books.set(book.provider, { time: now, bids, asks });
  }

  snapshot(now = Date.now()) {
    this.prune(now);
    const recentQuotes = this.quotes.slice(-5000);
    const recentTrades = this.trades.slice(-10_000);
    const mids = recentQuotes.map((row) => (row.bid + row.ask) / 2);
    const spreads = recentQuotes.map((row) => {
      const mid = (row.bid + row.ask) / 2;
      return mid > 0 ? (row.ask - row.bid) / mid * 10_000 : 0;
    });
    const validBooks = [...this.books.values()].filter((row) => now - row.time < 90_000);
    const bookRows = validBooks.map((book) => {
      const midpoint = (finite(book.bids[0]?.[0]) + finite(book.asks[0]?.[0])) / 2;
      return bookMetrics(book.bids, book.asks, midpoint);
    });
    const buyUsd = recentTrades.filter((row) => row.side === 'buy').reduce((sum, row) => sum + row.price * row.size, 0);
    const sellUsd = recentTrades.filter((row) => row.side === 'sell').reduce((sum, row) => sum + row.price * row.size, 0);
    const tradeUsd = buyUsd + sellUsd;
    const quotesByProvider = new Map();
    for (const row of recentQuotes) quotesByProvider.set(row.provider, [...(quotesByProvider.get(row.provider) || []), row]);
    const providerMoves = [];
    const quoteReturnsBps = [];
    for (const rows of quotesByProvider.values()) {
      const providerMids = rows.map((row) => (row.bid + row.ask) / 2);
      if (providerMids[0] > 0) providerMoves.push((providerMids.at(-1) / providerMids[0] - 1) * 10_000);
      for (let index = 1; index < providerMids.length; index += 1) {
        if (providerMids[index - 1] > 0) quoteReturnsBps.push((providerMids[index] / providerMids[index - 1] - 1) * 10_000);
      }
    }
    const priceMoveBps = average(providerMoves);
    const providers = new Set([...recentQuotes.map((row) => row.provider), ...recentTrades.map((row) => row.provider), ...this.books.keys()]);
    const buyRatio = tradeUsd > 0 ? buyUsd / tradeUsd : 0.5;
    const depthImbalance = average(bookRows.map((row) => row.depthImbalance));
    return {
      available: recentQuotes.length >= 4 || recentTrades.length >= 5 || validBooks.length > 0,
      symbol: this.symbol, observedAt: new Date(now).toISOString(), windowSeconds: this.windowMs / 1000,
      providerCount: providers.size, quoteCount: recentQuotes.length, tradeCount: recentTrades.length,
      spreadBps: average(spreads), spreadP95Bps: spreads.length ? [...spreads].sort((a, b) => a - b)[Math.floor((spreads.length - 1) * 0.95)] : 0,
      quoteVolatilityBps: standardDeviation(quoteReturnsBps),
      depthImbalance: clamp(depthImbalance, -1, 1),
      depthUsd1Pct: average(bookRows.map((row) => row.depthUsd1Pct)),
      orderFlowImbalance: tradeUsd > 0 ? (buyUsd - sellUsd) / tradeUsd : 0,
      aggressorBuyRatio: buyRatio, cumulativeVolumeDeltaUsd: buyUsd - sellUsd,
      tradeVolumeUsd: tradeUsd, tradesPerMinute: recentTrades.length / Math.max(1, this.windowMs / 60_000),
      priceMoveBps, priceImpactBpsPerMillion: tradeUsd > 0 ? Math.abs(priceMoveBps) / (tradeUsd / 1_000_000) : 0,
      adverseLiquidity: spreads.length > 0 && (average(spreads) > 20 || average(bookRows.map((row) => row.depthUsd1Pct)) < 10_000)
    };
  }
}

export async function appendMicrostructureSamples(samples = []) {
  const rows = samples.filter((row) => row?.symbol && row?.observedAt);
  if (!rows.length) return 0;
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    await ensureDataDir();
    await fs.mkdir(paths.microstructureDir(), { recursive: true, mode: 0o700 });
    const groups = new Map();
    for (const row of rows) {
      const file = path.join(paths.microstructureDir(), `micro-${safe(row.symbol)}-${monthKey(row.observedAt)}.ndjson`);
      groups.set(file, [...(groups.get(file) || []), row]);
    }
    for (const [file, batch] of groups) {
      await fs.appendFile(file, `${batch.map((row) => JSON.stringify(row)).join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  });
  await writeQueue;
  return rows.length;
}

export async function loadMicrostructureSamples(symbol, options = {}) {
  await ensureDataDir();
  await fs.mkdir(paths.microstructureDir(), { recursive: true, mode: 0o700 });
  const names = (await fs.readdir(paths.microstructureDir()).catch(() => []))
    .filter((name) => name.startsWith(`micro-${safe(symbol)}-`) && name.endsWith('.ndjson')).sort().slice(-(Number(options.months) || 6));
  const rows = [];
  for (const name of names) {
    for (const line of String(await fs.readFile(path.join(paths.microstructureDir(), name), 'utf8').catch(() => '')).split(/\r?\n/)) {
      if (!line) continue;
      try { rows.push(JSON.parse(line)); } catch { /* tolerate a partial final append */ }
    }
  }
  return rows.slice(-(Number(options.limit) || 200_000));
}

// Licensed vendors use different schemas. This importer deliberately accepts a
// normalized NDJSON contract so vendor-specific conversion happens outside the bot.
export async function importNormalizedMicrostructureFile(file) {
  const text = await fs.readFile(file, 'utf8');
  const rows = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const valid = rows.filter((row) => row?.symbol && row?.observedAt && typeof row.available === 'boolean');
  await appendMicrostructureSamples(valid);
  return { read: rows.length, imported: valid.length, rejected: rows.length - valid.length };
}

export async function pruneMicrostructure(retentionDays = 730, now = new Date()) {
  await ensureDataDir();
  await fs.mkdir(paths.microstructureDir(), { recursive: true, mode: 0o700 });
  const cutoff = new Date(now).getTime() - Math.max(30, Number(retentionDays) || 730) * 86_400_000;
  let removed = 0;
  for (const entry of await fs.readdir(paths.microstructureDir(), { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(/(\d{4}-\d{2})\.ndjson$/);
    if (match && new Date(`${match[1]}-01T00:00:00Z`).getTime() + 35 * 86_400_000 < cutoff) {
      await fs.unlink(path.join(paths.microstructureDir(), entry.name)).catch(() => {});
      removed += 1;
    }
  }
  return removed;
}
