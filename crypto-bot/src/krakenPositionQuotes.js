import WebSocket from 'ws';
import { hasExplicitFiniteAmount } from '../../new-bots/shared/strategyConfig.js';

/** Native WS v2 top-of-book observation; local receipt time is never a market timestamp. */
export function parseKrakenPositionQuote(row, { now = Date.now(), maxQuoteAgeMs = 15000 } = {}) {
  if (typeof row?.symbol !== 'string' || !/^[A-Z0-9]{1,32}\/[A-Z0-9]{1,32}$/.test(row.symbol)) return null;
  if (![row.bid, row.ask, row.bid_qty, row.ask_qty].every(hasExplicitFiniteAmount)) return null;
  const bid = Number(row.bid), ask = Number(row.ask), bidSize = Number(row.bid_qty), askSize = Number(row.ask_qty);
  const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  if (!(bid > 0 && ask >= bid && bidSize > 0 && askSize > 0) || !Number.isFinite(at) || at > now + 5000 || now - at > maxQuoteAgeMs) return null;
  return { symbol: row.symbol, bid, ask, bidSize, askSize, time: new Date(at).toISOString() };
}

/** One bounded public connection. No account authentication, history, trades or orders. */
export async function collectKrakenPositionQuotes(symbols, { clock = Date.now, timeoutMs = 8000, maxQuoteAgeMs = 15000,
  connect = () => new WebSocket('wss://ws.kraken.com/v2', { handshakeTimeout: 8000, maxPayload: 2 * 1024 * 1024 }) } = {}) {
  if (!Array.isArray(symbols) || symbols.some(s => typeof s !== 'string' || !/^[A-Z0-9]{1,32}\/[A-Z0-9]{1,32}$/.test(s))) throw new TypeError('Invalid Kraken symbols.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000 || !Number.isFinite(maxQuoteAgeMs) || maxQuoteAgeMs <= 0) throw new TypeError('Invalid Kraken quote limits.');
  const requested = new Set(symbols), started = clock();
  if (!requested.size) return { quotes: new Map(), diagnostics: { status: 'idle', sessions: 0, durationMs: 0 } };
  return new Promise(resolve => {
    let socket, timer, finished = false, online = false;
    const quotes = new Map(), acknowledged = new Set(), failed = new Set(), requestSymbols = new Map();
    const finish = (status, discard = false) => {
      if (finished) return; finished = true; clearTimeout(timer);
      if (discard) quotes.clear();
      const at = clock();
      for (const [symbol, q] of quotes) if (!online || !acknowledged.has(symbol) || failed.has(symbol)
        || at - Date.parse(q.time) > maxQuoteAgeMs || Date.parse(q.time) > at + 5000) quotes.delete(symbol);
      if (status === 'complete' && quotes.size !== requested.size) status = 'partial';
      // Only the collector can attest that status and this exact subscription
      // were acknowledged; a bare ticker parser never creates this evidence.
      for (const [symbol, q] of quotes) quotes.set(symbol, { ...q, cryptoQuoteEvidence: {
        version: 1, kind: 'kraken_l1_bbo', symbol, time: q.time, bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize,
        eventTrigger: 'bbo', systemStatus: 'online', subscriptionAcknowledged: true,
      } });
      // Keep an error listener while a connecting socket terminates.
      socket?.removeAllListeners('message'); socket?.removeAllListeners('open');
      try { socket?.terminate(); } catch { /* bounded collector has already stopped */ }
      resolve({ quotes, diagnostics: { status, sessions: 1, requested: requested.size, quoted: quotes.size,
        missing: requested.size - quotes.size, acknowledged: acknowledged.size, subscriptionFailures: failed.size,
        durationMs: Math.max(0, at - started) } });
    };
    const maybeFinish = () => {
      if (online && [...requested].every(s => failed.has(s) || (acknowledged.has(s) && quotes.has(s)))) finish(failed.size ? 'partial' : 'complete');
    };
    timer = setTimeout(() => finish('timeout'), timeoutMs);
    try {
      socket = connect();
      socket.on('error', () => finish('socket_error', true));
      socket.on('close', () => finish('socket_closed', true));
      socket.on('open', () => {
        const all = [...requested];
        try {
          for (let offset = 0, id = 1; offset < all.length; offset += 50, id++) {
            const batch = all.slice(offset, offset + 50); requestSymbols.set(id, new Set(batch));
            socket.send(JSON.stringify({ method: 'subscribe', req_id: id, params: { channel: 'ticker', symbol: batch, event_trigger: 'bbo', snapshot: true } }));
          }
        } catch { finish('subscription_send_failed', true); }
      });
      socket.on('message', buffer => {
        if (finished) return;
        let message;
        try { message = JSON.parse(String(buffer)); } catch { finish('invalid_json', true); return; }
        if (message?.channel === 'status') {
          online = Array.isArray(message.data) && message.data.length === 1 && message.data[0]?.system === 'online';
          if (!online) { finish('system_not_online', true); return; }
        } else if (message?.method === 'subscribe') {
          const batch = requestSymbols.get(message.req_id), symbol = message.result?.symbol;
          if (!batch) return;
          if (message.success === false) {
            for (const s of symbol && batch.has(symbol) ? [symbol] : batch) { failed.add(s); quotes.delete(s); }
          } else if (message.success === true && message.result?.channel === 'ticker' && batch.has(symbol)) acknowledged.add(symbol);
        } else if (message?.channel === 'ticker' && ['snapshot', 'update'].includes(message.type) && Array.isArray(message.data)) {
          for (const row of message.data) {
            if (!requested.has(row?.symbol) || failed.has(row.symbol)) continue;
            const q = parseKrakenPositionQuote(row, { now: clock(), maxQuoteAgeMs });
            if (!q) { quotes.delete(row.symbol); continue; }
            if (!quotes.has(q.symbol) || Date.parse(q.time) > Date.parse(quotes.get(q.symbol).time)) quotes.set(q.symbol, q);
          }
        }
        maybeFinish();
      });
    } catch { finish('connection_failed', true); }
  });
}
