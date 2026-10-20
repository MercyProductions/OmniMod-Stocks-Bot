import WebSocket from 'ws';
import { config } from './config.js';
import { parseAlpacaStockQuote } from '../../new-bots/shared/stockQuoteEvidence.js';

const quotes = new Map();
const trades = new Map();
const bars = new Map();
const quoteHistory = new Map();
const tradeHistory = new Map();
const barHistory = new Map();
const statuses = new Map();
const lulds = new Map();
const symbolGroups = new Map();
const barHandlers = new Set();
let socket = null;
let authenticated = false;
let explicitlyStopped = true;
let reconnectTimer = null;
let pingTimer = null;
let reconnectAttempts = 0;
let subscribed = new Set();

const state = {
  configured: Boolean(config.alpacaKeyId && config.alpacaSecretKey),
  enabled: config.alpacaStreamEnabled,
  connection: 'stopped',
  feed: config.alpacaDataFeed,
  desiredSymbols: 0,
  subscribedSymbols: 0,
  lastConnectedAt: '',
  lastMessageAt: '',
  lastError: '',
  reconnectAttempts: 0
};

function desiredSymbols() {
  const ordered = [];
  for (const symbols of symbolGroups.values()) {
    for (const symbol of symbols) if (!ordered.includes(symbol)) ordered.push(symbol);
  }
  return ordered.slice(0, config.alpacaStreamMaxSymbols);
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function reconcileSubscriptions() {
  if (!authenticated) return;
  const desired = new Set(desiredSymbols());
  const removed = [...subscribed].filter((symbol) => !desired.has(symbol));
  const added = [...desired].filter((symbol) => !subscribed.has(symbol));
  if (removed.length) send({ action: 'unsubscribe', trades: removed, quotes: removed, bars: removed, updatedBars: removed, statuses: removed, lulds: removed });
  if (added.length) send({ action: 'subscribe', trades: added, quotes: added, bars: added, updatedBars: added, statuses: added, lulds: added });
  subscribed = desired;
  state.desiredSymbols = desired.size;
  state.subscribedSymbols = subscribed.size;
}

function normalizedTimestamp(value) {
  const milliseconds = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : '';
}

function remember(store, symbol, value, now = Date.now()) {
  const rows = store.get(symbol) || [];
  rows.push(value);
  const cutoff = now - 16 * 60_000;
  while (rows.length && rows[0].timeMs < cutoff) rows.shift();
  if (rows.length > 4000) rows.splice(0, rows.length - 4000);
  store.set(symbol, rows);
}

function average(rows, field) {
  return rows.length ? rows.reduce((sum, row) => sum + (Number(row[field]) || 0), 0) / rows.length : 0;
}

function windowRows(store, symbol, minutes, now) {
  return (store.get(symbol) || []).filter((row) => row.timeMs >= now - minutes * 60_000);
}

function handleQuote(message) {
  let stockQuoteEvidence = null, stockQuoteRejection = null;
  try { stockQuoteEvidence = parseAlpacaStockQuote(message, { symbol: message.S, feed: config.alpacaDataFeed,
    source: 'stream', maxQuoteAgeMs: 60000 }).stockQuoteEvidence; }
  catch (error) { stockQuoteRejection = error.code || 'stock_quote_evidence_required'; }
  const bid = Number(message.bp); const ask = Number(message.ap);
  const bidSize = Number(message.bs) || 0; const askSize = Number(message.as) || 0;
  const midpoint = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
  const timestamp = normalizedTimestamp(message.t); const timeMs = Date.parse(timestamp) || Date.now();
  const value = {
    symbol: message.S,
    stockQuoteEvidence,
    stockQuoteRejection,
    bid,
    ask,
    bidSize,
    askSize,
    midpoint,
    spreadBps: midpoint ? (ask - bid) / midpoint * 10_000 : 0,
    quoteImbalance: bidSize + askSize ? (bidSize - askSize) / (bidSize + askSize) : 0,
    timestamp,
    timeMs,
    tape: message.z || '',
    conditions: message.c || []
  };
  quotes.set(message.S, value);
  remember(quoteHistory, message.S, value, timeMs);
}

function handleTrade(message) {
  const timestamp = normalizedTimestamp(message.t); const timeMs = Date.parse(timestamp) || Date.now();
  const price = Number(message.p) || 0; const size = Number(message.s) || 0;
  const midpoint = quotes.get(message.S)?.midpoint || 0;
  const prior = trades.get(message.S)?.price || price;
  const direction = midpoint ? (price > midpoint ? 1 : price < midpoint ? -1 : price >= prior ? 1 : -1) : price >= prior ? 1 : -1;
  const value = {
    symbol: message.S,
    price,
    size,
    signedVolume: direction * size,
    timestamp,
    timeMs,
    exchange: message.x || '',
    conditions: message.c || []
  };
  trades.set(message.S, value);
  remember(tradeHistory, message.S, value, timeMs);
}

function handleBar(message) {
  const bar = {
    symbol: message.S,
    timestamp: Math.floor(Date.parse(message.t) / 1000),
    open: Number(message.o),
    high: Number(message.h),
    low: Number(message.l),
    close: Number(message.c),
    volume: Number(message.v) || 0,
    tradeCount: Number(message.n) || 0,
    vwap: Number(message.vw) || 0,
    updated: message.T === 'u'
  };
  if (![bar.open, bar.high, bar.low, bar.close, bar.timestamp].every(Number.isFinite)) return;
  bars.set(message.S, bar);
  remember(barHistory, message.S, { ...bar, timeMs: bar.timestamp * 1000 }, bar.timestamp * 1000);
  for (const handler of barHandlers) Promise.resolve(handler(bar)).catch(() => {});
}

function handleStatus(message) {
  const code = String(message.sc || '');
  const resumed = ['3', 'Q', 'T'].includes(code);
  const halted = ['2', 'H'].includes(code) || /halt/i.test(String(message.sm || ''));
  statuses.set(message.S, {
    symbol: message.S, code, message: String(message.sm || ''), reasonCode: String(message.rc || ''),
    reason: String(message.rm || ''), halted: resumed ? false : halted, timestamp: normalizedTimestamp(message.t)
  });
}

function handleLuld(message) {
  lulds.set(message.S, {
    symbol: message.S, upper: Number(message.u) || 0, lower: Number(message.d) || 0,
    indicator: String(message.i || ''), timestamp: normalizedTimestamp(message.t)
  });
}

function handleMessage(raw) {
  let messages;
  try { messages = JSON.parse(raw.toString()); } catch { return; }
  if (!Array.isArray(messages)) messages = [messages];
  state.lastMessageAt = new Date().toISOString();
  for (const message of messages) {
    if (message.T === 'success' && message.msg === 'connected') {
      send({ action: 'auth', key: config.alpacaKeyId, secret: config.alpacaSecretKey });
    } else if (message.T === 'success' && message.msg === 'authenticated') {
      authenticated = true;
      reconnectAttempts = 0;
      state.connection = 'streaming';
      state.lastConnectedAt = new Date().toISOString();
      state.lastError = '';
      subscribed = new Set();
      reconcileSubscriptions();
    } else if (message.T === 'error') {
      state.connection = 'error';
      state.lastError = `${message.code || 'stream'}: ${String(message.msg || 'Unknown Alpaca stream error').slice(0, 180)}`;
    } else if (message.T === 'subscription') {
      state.subscribedSymbols = new Set([...(message.quotes || []), ...(message.trades || []), ...(message.bars || [])]).size;
    } else if (message.T === 'q') handleQuote(message);
    else if (message.T === 't') handleTrade(message);
    else if (message.T === 'b' || message.T === 'u') handleBar(message);
    else if (message.T === 's') handleStatus(message);
    else if (message.T === 'l') handleLuld(message);
  }
}

function clearTimers() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (pingTimer) clearInterval(pingTimer);
  reconnectTimer = null;
  pingTimer = null;
}

function scheduleReconnect() {
  if (explicitlyStopped || reconnectTimer) return;
  reconnectAttempts += 1;
  state.reconnectAttempts = reconnectAttempts;
  const delay = Math.min(60_000, 1_000 * 2 ** Math.min(6, reconnectAttempts - 1));
  state.connection = 'reconnecting';
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (explicitlyStopped || !state.configured || !state.enabled) return;
  clearTimers();
  authenticated = false;
  state.connection = 'connecting';
  socket = new WebSocket(`wss://stream.data.alpaca.markets/v2/${config.alpacaDataFeed}`, { handshakeTimeout: 15_000 });
  socket.on('message', handleMessage);
  socket.on('error', (error) => {
    state.lastError = String(error?.message || error).slice(0, 180);
    state.connection = 'error';
  });
  socket.on('close', (code, reason) => {
    authenticated = false;
    state.subscribedSymbols = 0;
    state.lastError = explicitlyStopped ? state.lastError : `Stream closed (${code}): ${String(reason || '').slice(0, 120)}`;
    socket = null;
    if (!explicitlyStopped) scheduleReconnect();
  });
  pingTimer = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) socket.ping();
  }, 25_000);
}

export function startAlpacaStream() {
  if (!state.configured) return { ...state, connection: 'not_configured' };
  if (!state.enabled) return { ...state, connection: 'disabled' };
  if (!explicitlyStopped && socket) return getAlpacaStreamStatus();
  explicitlyStopped = false;
  connect();
  return getAlpacaStreamStatus();
}

export function stopAlpacaStream() {
  explicitlyStopped = true;
  clearTimers();
  authenticated = false;
  if (socket) socket.close(1000, 'Bot shutdown');
  socket = null;
  state.connection = 'stopped';
  state.subscribedSymbols = 0;
}

export function updateAlpacaStreamSymbols(owner, values) {
  const group = String(owner || 'default');
  const symbols = [...new Set((values || []).map((value) => String(value).trim().toUpperCase()).filter((value) => /^[A-Z][A-Z0-9.-]{0,10}$/.test(value)))];
  symbolGroups.set(group, symbols);
  state.desiredSymbols = desiredSymbols().length;
  reconcileSubscriptions();
  return desiredSymbols();
}

export function registerAlpacaBarHandler(handler) {
  barHandlers.add(handler);
  return () => barHandlers.delete(handler);
}

export function getAlpacaStreamSnapshot(symbol, now = Date.now()) {
  const ticker = String(symbol || '').toUpperCase();
  const quote = quotes.get(ticker);
  const trade = trades.get(ticker);
  const bar = bars.get(ticker);
  const quoteAgeMs = quote?.timestamp ? now - new Date(quote.timestamp).getTime() : Infinity;
  const tradeAgeMs = trade?.timestamp ? now - new Date(trade.timestamp).getTime() : Infinity;
  if (quoteAgeMs > 90_000 && tradeAgeMs > 90_000) return null;
  const quote1m = windowRows(quoteHistory, ticker, 1, now);
  const quote5m = windowRows(quoteHistory, ticker, 5, now);
  const quote15m = windowRows(quoteHistory, ticker, 15, now);
  const tradeFlow = (minutes) => {
    const rows = windowRows(tradeHistory, ticker, minutes, now);
    const total = rows.reduce((sum, row) => sum + Math.abs(row.signedVolume || 0), 0);
    return total ? rows.reduce((sum, row) => sum + (row.signedVolume || 0), 0) / total : 0;
  };
  const spreadMean1m = average(quote1m, 'spreadBps') || quote?.spreadBps || 0;
  const spreadMean5m = average(quote5m, 'spreadBps') || spreadMean1m;
  const spreadMean15m = average(quote15m, 'spreadBps') || spreadMean5m;
  const spreadPercentile15m = quote15m.length ? quote15m.filter((row) => row.spreadBps <= (quote?.spreadBps || 0)).length / quote15m.length : 0.5;
  const status = statuses.get(ticker);
  const luld = lulds.get(ticker);
  const statusFresh = status?.timestamp && now - Date.parse(status.timestamp) <= 8 * 60 * 60_000;
  const luldFresh = luld?.timestamp && now - Date.parse(luld.timestamp) <= 30 * 60_000;
  const executablePrice = trade?.price || quote?.midpoint || 0;
  const luldDistances = luldFresh ? [luld?.upper, luld?.lower].filter((value) => value > 0 && executablePrice > 0).map((value) => Math.abs(value / executablePrice - 1) * 10_000) : [];
  return {
    provider: `Alpaca ${config.alpacaDataFeed.toUpperCase()} stream`,
    stockQuoteEvidence: quote?.stockQuoteEvidence || null,
    stockQuoteRejection: quote?.stockQuoteRejection || null,
    price: tradeAgeMs <= 90_000 && trade?.price > 0 ? trade.price : quote?.midpoint || 0,
    timestamp: tradeAgeMs <= quoteAgeMs ? trade?.timestamp : quote?.timestamp,
    classification: 'intraday',
    streaming: true,
    bid: quote?.bid || 0,
    ask: quote?.ask || 0,
    bidSize: quote?.bidSize || 0,
    askSize: quote?.askSize || 0,
    spreadBps: quote?.spreadBps || 0,
    quoteImbalance: quote?.quoteImbalance || 0,
    spreadMean1m,
    spreadMean5m,
    spreadMean15m,
    spreadPercentile15m,
    spreadAcceleration: spreadMean15m ? spreadMean1m / spreadMean15m - 1 : 0,
    quoteImbalance1m: average(quote1m, 'quoteImbalance'),
    quoteImbalance5m: average(quote5m, 'quoteImbalance'),
    quoteImbalance15m: average(quote15m, 'quoteImbalance'),
    tradeFlow1m: tradeFlow(1),
    tradeFlow5m: tradeFlow(5),
    tradeFlow15m: tradeFlow(15),
    quoteAgeSeconds: Number.isFinite(quoteAgeMs) ? quoteAgeMs / 1000 : null,
    tradeAgeSeconds: Number.isFinite(tradeAgeMs) ? tradeAgeMs / 1000 : null,
    luldUpper: luldFresh ? luld?.upper || 0 : 0,
    luldLower: luldFresh ? luld?.lower || 0 : 0,
    luldDistanceBps: luldDistances.length ? Math.min(...luldDistances) : 10000,
    luldIndicator: luldFresh ? luld?.indicator || '' : '',
    halted: Boolean(statusFresh && status?.halted),
    tradingStatus: statusFresh ? status : null,
    quoteTimestamp: quote?.timestamp || '',
    tradeTimestamp: trade?.timestamp || '',
    bar
  };
}

export function getAlpacaStreamStatus() {
  return { ...state, desiredSymbols: desiredSymbols().length, cachedQuotes: quotes.size, cachedTrades: trades.size, cachedBars: bars.size, cachedStatuses: statuses.size, cachedLulds: lulds.size };
}
