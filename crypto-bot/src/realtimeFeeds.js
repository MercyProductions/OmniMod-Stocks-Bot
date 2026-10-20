import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { appendMicrostructureSamples, MicrostructureAccumulator } from './microstructure.js';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const alias = (symbol) => String(symbol || '').toUpperCase() === 'XBT' ? 'BTC' : String(symbol || '').toUpperCase();

export function parseBinanceMessage(payload) {
  const row = payload?.data || payload;
  const pair = String(row?.s || '').toUpperCase();
  if (!pair.endsWith('USDT')) return null;
  const bid = finite(row.b);
  const ask = finite(row.a);
  return bid > 0 && ask > 0 ? { provider: 'Binance WS', symbol: pair.slice(0, -4), bid, ask, price: (bid + ask) / 2 } : null;
}

export function parseCoinbaseMessage(payload) {
  if (payload?.type !== 'ticker') return null;
  const symbol = String(payload.product_id || '').split('-')[0];
  const bid = finite(payload.best_bid);
  const ask = finite(payload.best_ask);
  const price = bid > 0 && ask > 0 ? (bid + ask) / 2 : finite(payload.price);
  return symbol && price > 0 ? { provider: 'Coinbase WS', symbol: alias(symbol), bid, ask, price } : null;
}

export function parseKrakenMessage(payload) {
  if (payload?.channel !== 'ticker' || !Array.isArray(payload.data)) return null;
  const row = payload.data[0] || {};
  const pair = String(row.symbol || '').toUpperCase();
  const [baseSymbol = '', quoteSymbol = ''] = pair.split('/');
  const symbol = alias(baseSymbol);
  const bid = finite(row.bid);
  const ask = finite(row.ask);
  const price = bid > 0 && ask > 0 ? (bid + ask) / 2 : finite(row.last);
  const providerObservedAt = typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp)) ? row.timestamp : null;
  return symbol && price > 0 ? {
    provider: 'Kraken WS', symbol, pair, base: alias(baseSymbol), target: alias(quoteSymbol), bid, ask, price, providerObservedAt,
    timestampBasis: providerObservedAt ? 'provider_event' : 'unknown'
  } : null;
}

export function parseBinanceEvents(payload) {
  const row = payload?.data || payload;
  const pair = String(row?.s || '').toUpperCase();
  const symbol = pair.endsWith('USDT') ? pair.slice(0, -4) : '';
  if (!symbol) return [];
  if (row.e === 'aggTrade') return [{
    kind: 'trade', provider: 'Binance WS', symbol, price: finite(row.p), size: finite(row.q), side: row.m ? 'sell' : 'buy'
  }];
  if (Array.isArray(row.b) && Array.isArray(row.a)) return [{ kind: 'book', provider: 'Binance WS', symbol, bids: row.b, asks: row.a }];
  const quote = parseBinanceMessage(row);
  return quote ? [{ kind: 'quote', ...quote, bidSize: finite(row.B), askSize: finite(row.A) }] : [];
}

export function parseCoinbaseEvents(payload) {
  const symbol = alias(String(payload?.product_id || '').split('-')[0]);
  if (!symbol) return [];
  if (payload.type === 'snapshot') return [{ kind: 'book_delta', provider: 'Coinbase WS', symbol, snapshot: true, bids: payload.bids || [], asks: payload.asks || [] }];
  if (payload.type === 'l2update') return [{ kind: 'book_delta', provider: 'Coinbase WS', symbol, changes: payload.changes || [] }];
  if (payload.type === 'match' || payload.type === 'last_match') return [{
    kind: 'trade', provider: 'Coinbase WS', symbol, price: finite(payload.price), size: finite(payload.size),
    // Coinbase `match.side` is the resting maker side; aggressor flow is the opposite side.
    side: payload.side === 'sell' ? 'buy' : 'sell'
  }];
  const quote = parseCoinbaseMessage(payload);
  return quote ? [{ kind: 'quote', ...quote, bidSize: finite(payload.best_bid_size), askSize: finite(payload.best_ask_size) }] : [];
}

export function parseKrakenEvents(payload) {
  if (!Array.isArray(payload?.data)) return [];
  if (payload.channel === 'trade') return payload.data.map((row) => ({
    kind: 'trade', provider: 'Kraken WS', symbol: alias(String(row.symbol || '').split('/')[0]),
    price: finite(row.price), size: finite(row.qty), side: row.side === 'sell' ? 'sell' : 'buy'
  }));
  if (payload.channel === 'book') {
    const row = payload.data[0] || {};
    return [{
      kind: 'book_delta', provider: 'Kraken WS', symbol: alias(String(row.symbol || '').split('/')[0]),
      snapshot: payload.type === 'snapshot',
      bids: (row.bids || []).map((level) => [level.price, level.qty]),
      asks: (row.asks || []).map((level) => [level.price, level.qty])
    }];
  }
  const quote = parseKrakenMessage(payload);
  return quote ? [{ kind: 'quote', ...quote, bidSize: finite(payload.data[0]?.bid_qty), askSize: finite(payload.data[0]?.ask_qty) }] : [];
}

export class RealtimeMarketHub extends EventEmitter {
  constructor(options = {}) {
    super();
    this.enabled = options.enabled !== false;
    this.movementThresholdPct = Math.max(0.1, Number(options.movementThresholdPct) || 0.45);
    this.onThreshold = typeof options.onThreshold === 'function' ? options.onThreshold : null;
    this.symbols = [];
    this.sockets = new Map();
    this.quotes = new Map();
    this.baselines = new Map();
    this.reconnectTimers = new Map();
    this.failureCounts = new Map();
    this.blockedUntil = new Map();
    this.accumulators = new Map();
    this.books = new Map();
    this.flushSeconds = Math.max(10, Number(options.flushSeconds) || 30);
    this.flushTimer = null;
    this.stopped = false;
  }

  start(assets = []) {
    if (!this.enabled) return;
    this.stopped = false;
    const symbols = [...new Set(assets.map((asset) => alias(asset.symbol)).filter(Boolean))].slice(0, 20);
    if (JSON.stringify(symbols) === JSON.stringify(this.symbols) && this.sockets.size) return;
    this.closeSockets();
    this.symbols = symbols;
    if (!symbols.length) return;
    this.connectBinance();
    this.connectCoinbase();
    this.connectKraken();
    this.startFlushTimer();
  }

  connect(name, url, onOpen, parser) {
    if (this.stopped || !this.symbols.length || (this.blockedUntil.get(name) || 0) > Date.now()) return;
    const socket = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.sockets.set(name, socket);
    socket.on('open', () => {
      this.failureCounts.set(name, 0);
      onOpen?.(socket);
      this.emit('provider', { provider: name, state: 'connected' });
    });
    socket.on('message', (buffer) => {
      try {
        const events = parser(JSON.parse(String(buffer)));
        for (const event of Array.isArray(events) ? events : events ? [events] : []) this.recordMarketEvent(event);
      } catch { /* ignore malformed provider frames */ }
    });
    socket.on('pong', () => { socket.lastPongAt = Date.now(); });
    socket.on('error', (error) => {
      if (/451|restricted location|eligibility/i.test(error.message)) this.blockedUntil.set(name, Date.now() + 60 * 60_000);
      this.emit('provider', { provider: name, state: 'error', error: error.message });
    });
    socket.on('close', () => {
      this.sockets.delete(name);
      this.emit('provider', { provider: name, state: 'closed' });
      if (!this.stopped && (this.blockedUntil.get(name) || 0) <= Date.now()) {
        const failures = (this.failureCounts.get(name) || 0) + 1;
        this.failureCounts.set(name, failures);
        const delay = Math.min(5 * 60_000, 5_000 * (2 ** Math.min(6, failures - 1)));
        clearTimeout(this.reconnectTimers.get(name));
        this.reconnectTimers.set(name, setTimeout(() => this.reconnectProvider(name), delay));
      }
    });
  }

  connectBinance() {
    const streams = this.symbols.flatMap((symbol) => [
      `${symbol.toLowerCase()}usdt@bookTicker`, `${symbol.toLowerCase()}usdt@aggTrade`, `${symbol.toLowerCase()}usdt@depth20@100ms`
    ]).join('/');
    this.connect('Binance', `wss://stream.binance.com:9443/stream?streams=${streams}`, null, parseBinanceEvents);
  }

  connectCoinbase() {
    this.connect('Coinbase', 'wss://ws-feed.exchange.coinbase.com', (socket) => socket.send(JSON.stringify({
      type: 'subscribe', product_ids: this.symbols.map((symbol) => `${symbol}-USD`), channels: ['ticker']
    })), parseCoinbaseEvents);
    const socket = this.sockets.get('Coinbase');
    socket?.once('open', () => socket.send(JSON.stringify({
      type: 'subscribe', product_ids: this.symbols.map((symbol) => `${symbol}-USD`), channels: ['level2', 'matches']
    })));
  }

  connectKraken() {
    this.connect('Kraken', 'wss://ws.kraken.com/v2', (socket) => {
      const symbols = this.symbols.map((symbol) => `${symbol}/USD`);
      socket.send(JSON.stringify({ method: 'subscribe', params: { channel: 'ticker', symbol: symbols, event_trigger: 'bbo', snapshot: true } }));
      socket.send(JSON.stringify({ method: 'subscribe', params: { channel: 'book', symbol: symbols, depth: 10, snapshot: true } }));
      socket.send(JSON.stringify({ method: 'subscribe', params: { channel: 'trade', symbol: symbols, snapshot: false } }));
    }, parseKrakenEvents);
  }

  reconnectProvider(name) {
    if (name === 'Binance') this.connectBinance();
    if (name === 'Coinbase') this.connectCoinbase();
    if (name === 'Kraken') this.connectKraken();
  }

  recordQuote(quote) {
    const symbol = alias(quote.symbol);
    const providers = this.quotes.get(symbol) || new Map();
    const receivedAt = new Date().toISOString();
    providers.set(quote.provider, { ...quote, receivedAt, observedAt: receivedAt });
    this.quotes.set(symbol, providers);
    this.emit('quote', { symbol, provider: quote.provider });
    const consensus = this.getConsensus(symbol);
    const baseline = this.baselines.get(symbol);
    if (!baseline) this.baselines.set(symbol, { price: consensus.price, at: Date.now() });
    else if (baseline.price > 0) {
      const movementPct = (consensus.price / baseline.price - 1) * 100;
      if (Math.abs(movementPct) >= this.movementThresholdPct && Date.now() - baseline.at >= 30_000) {
        this.baselines.set(symbol, { price: consensus.price, at: Date.now() });
        const event = { symbol, movementPct, consensus, triggeredAt: new Date().toISOString() };
        this.emit('threshold', event);
        this.onThreshold?.(event);
      }
    }
  }

  accumulator(symbol) {
    const key = alias(symbol);
    if (!this.accumulators.has(key)) this.accumulators.set(key, new MicrostructureAccumulator(key));
    return this.accumulators.get(key);
  }

  applyBookDelta(event) {
    const key = `${event.provider}:${alias(event.symbol)}`;
    const state = this.books.get(key) || { bids: new Map(), asks: new Map() };
    if (event.snapshot) { state.bids.clear(); state.asks.clear(); }
    const update = (side, price, size) => {
      const map = side === 'buy' ? state.bids : state.asks;
      const numericPrice = finite(price);
      const numericSize = finite(size);
      if (!(numericPrice > 0)) return;
      if (numericSize <= 0) map.delete(numericPrice); else map.set(numericPrice, numericSize);
    };
    for (const [price, size] of event.bids || []) update('buy', price, size);
    for (const [price, size] of event.asks || []) update('sell', price, size);
    for (const [side, price, size] of event.changes || []) update(side, price, size);
    const bids = [...state.bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, 50);
    const asks = [...state.asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, 50);
    this.books.set(key, state);
    if (bids.length && asks.length) this.accumulator(event.symbol).recordBook({ provider: event.provider, bids, asks });
  }

  recordMarketEvent(event) {
    if (!event?.symbol) return;
    if (event.kind === 'quote') {
      this.recordQuote(event);
      this.accumulator(event.symbol).recordQuote(event);
    } else if (event.kind === 'trade') this.accumulator(event.symbol).recordTrade(event);
    else if (event.kind === 'book') this.accumulator(event.symbol).recordBook(event);
    else if (event.kind === 'book_delta') this.applyBookDelta(event);
  }

  getMicrostructure(symbol) {
    return this.accumulator(symbol).snapshot();
  }

  startFlushTimer() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(() => {
      const samples = this.symbols.map((symbol) => this.getMicrostructure(symbol)).filter((row) => row.available);
      void appendMicrostructureSamples(samples).catch(() => {});
    }, this.flushSeconds * 1000);
    this.flushTimer.unref?.();
  }

  getConsensus(symbol) {
    const rows = [...(this.quotes.get(alias(symbol))?.values() || [])]
      .filter((row) => row.price > 0 && Date.now() - new Date(row.observedAt).getTime() < 60_000);
    const prices = rows.map((row) => row.price).sort((a, b) => a - b);
    const price = prices.length ? prices[Math.floor(prices.length / 2)] : 0;
    const dispersionPct = price > 0 && prices.length > 1 ? (prices.at(-1) - prices[0]) / price * 100 : 0;
    return { symbol: alias(symbol), price, providerCount: rows.length, dispersionPct, quotes: rows };
  }

  getExecutableKrakenQuote(symbol) {
    const quote = this.quotes.get(alias(symbol))?.get('Kraken WS');
    if (!quote || quote.timestampBasis !== 'provider_event' || !quote.providerObservedAt) return null;
    return {
      ...quote, provider: 'Kraken', observedAt: quote.providerObservedAt,
      timestampBasis: 'provider_event', feed: 'Kraken Spot WebSocket v2'
    };
  }

  async waitForExecutableKrakenQuotes(symbols = [], { timeoutMs = 3_000 } = {}) {
    const requested = [...new Set(symbols.map(alias).filter(Boolean))];
    const started = Date.now();
    const ready = () => requested.filter((symbol) => {
      const quote = this.getExecutableKrakenQuote(symbol);
      const ageMs = Date.now() - Date.parse(quote?.observedAt || '');
      return quote && quote.bid > 0 && quote.ask >= quote.bid
        && Number.isFinite(ageMs) && ageMs >= -5_000 && ageMs <= 300_000;
    });
    const summarize = (status) => ({ status, requested: requested.length,
      ready: ready().length, waitedMs: Date.now() - started });
    if (!requested.length) return summarize('not_needed');
    if (!this.enabled) return summarize('disabled');
    if (ready().length === requested.length) return summarize('ready');
    const waitMs = Math.max(0, Math.min(3_000, Number(timeoutMs) || 0));
    if (!waitMs) return summarize('unavailable');
    return new Promise((resolve) => {
      let timer;
      const finish = (status) => {
        clearTimeout(timer);
        this.off('quote', onQuote);
        resolve(summarize(status));
      };
      const onQuote = (event) => {
        if (event?.provider !== 'Kraken WS' || !requested.includes(event.symbol)) return;
        if (ready().length === requested.length) finish('ready');
      };
      this.on('quote', onQuote);
      timer = setTimeout(() => finish('partial_or_unavailable'), waitMs);
      if (ready().length === requested.length) finish('ready');
    });
  }

  status() {
    return {
      enabled: this.enabled, symbols: this.symbols.length,
      connectedProviders: [...this.sockets.values()].filter((socket) => socket.readyState === WebSocket.OPEN).length,
      quotes: [...this.quotes.values()].reduce((sum, providers) => sum + providers.size, 0),
      microstructureSymbols: [...this.accumulators.values()].filter((accumulator) => accumulator.snapshot().available).length,
      restrictedProviders: [...this.blockedUntil.entries()].filter(([, until]) => until > Date.now()).map(([name]) => name)
    };
  }

  closeSockets() {
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const socket of this.sockets.values()) {
      socket.removeAllListeners('close');
      socket.close();
    }
    this.sockets.clear();
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
  }

  stop() {
    this.stopped = true;
    this.closeSockets();
  }
}
