import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
import { parseKrakenMessage } from '../src/realtimeFeeds.js';
import { aggregateProviderQuotes, fetchProviderQuotes } from '../src/marketProviders.js';
import { appendKrakenWebsocketSmokeHistory, buildKrakenWebsocketSmokeHistoryRow } from '../src/krakenWebsocketSmokeHistory.js';

const symbols = ['BTC/USD', 'ETH/USD'];
const timeoutMs = 45_000;
const startedAt = Date.now();
const observations = new Map();
const aggregationResults = new Map();
const socket = new WebSocket('wss://ws.kraken.com/v2', { handshakeTimeout: 8_000 });

const close = () => {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
};

let finished = false;
const finish = (status, error = null) => {
  clearTimeout(timer);
  close();
  const rows = symbols.map((pair) => {
    const symbol = pair.split('/')[0];
    const quote = observations.get(symbol);
    const aggregate = aggregationResults.get(symbol);
    return {
      symbol, received: Boolean(quote), providerTimestampPresent: Boolean(quote?.providerObservedAt),
      quoteValid: Boolean(quote && quote.bid > 0 && quote.ask >= quote.bid),
      ageMs: quote ? Date.now() - Date.parse(quote.providerObservedAt) : null,
      acceptedProviders: aggregate?.providers || [], providerCount: aggregate?.providerCount || 0,
      krakenAccepted: aggregate?.providers.includes('Kraken') || false,
      conflicted: aggregate?.conflicted ?? null, rejectionCounts: aggregate?.rejectionCounts || {},
      providerErrorNames: aggregate?.providerErrorNames || [],
    };
  });
  const payload = {
    checkedAt: new Date().toISOString(), status, purpose: 'Public Kraken Spot WebSocket v2 quote through the Crypto multi-provider quote aggregator; no strategy or execution.',
    elapsedMs: Date.now() - startedAt, timeoutMs, observations: rows,
    error: error ? String(error.message || error).slice(0, 180) : null,
    limitations: ['Public read-only data only. No historical analysis, strategy decision, order, Discord post, or paper reservation was created.'],
  };
  const historyPath = fileURLToPath(new URL('../data/kraken-websocket-smoke-history.ndjson', import.meta.url));
  void appendKrakenWebsocketSmokeHistory(buildKrakenWebsocketSmokeHistoryRow(payload), { path: historyPath })
    .then(() => {
      payload.historyJournal = 'data/kraken-websocket-smoke-history.ndjson';
      console.log(JSON.stringify(payload, null, 2));
      if (status !== 'PASS_PROVIDER_AGGREGATION_ONLY') process.exitCode = 2;
    }).catch((historyError) => {
      payload.historyError = String(historyError.message || historyError).slice(0, 120);
      console.log(JSON.stringify(payload, null, 2));
      process.exitCode = 2;
    });
};

const timer = setTimeout(() => {
  if (finished) return;
  finished = true;
  finish('FAIL_OR_INCOMPLETE');
}, timeoutMs);

socket.on('open', () => {
  socket.send(JSON.stringify({ method: 'subscribe', params: {
    channel: 'ticker', symbol: symbols, event_trigger: 'bbo', snapshot: true,
  } }));
});
socket.on('message', (buffer) => {
  let payload;
  try { payload = JSON.parse(String(buffer)); } catch { return; }
  const quote = parseKrakenMessage(payload);
  if (!quote?.providerObservedAt) return;
  const ageMs = Date.now() - Date.parse(quote.providerObservedAt);
  if (!(quote.bid > 0 && quote.ask >= quote.bid && ageMs >= -5_000 && ageMs <= 300_000)) return;
  observations.set(quote.symbol, quote);
  if (symbols.every((pair) => observations.has(pair.split('/')[0])) && !pipelineStarted && !finished) {
    pipelineStarted = true;
    void verifyAggregation();
  }
});
socket.on('error', (error) => {
  if (finished) return;
  finished = true;
  finish('FAIL_OR_INCOMPLETE', error);
});
socket.on('close', () => {
  if (finished) return;
  finished = true;
  finish('FAIL_OR_INCOMPLETE', 'Kraken WebSocket closed before both provider-timestamped quotes arrived.');
});

let pipelineStarted = false;
async function verifyAggregation() {
  try {
    await Promise.all(symbols.map(async (pair) => {
      const symbol = pair.split('/')[0];
      const liveQuote = observations.get(symbol);
      const result = await fetchProviderQuotes({ id: symbol === 'BTC' ? 'bitcoin' : 'ethereum', symbol }, { realtimeQuote: {
        ...liveQuote, provider: 'Kraken', observedAt: liveQuote.providerObservedAt, timestampBasis: 'provider_event'
      } });
      const market = aggregateProviderQuotes(result.quotes, 0);
      aggregationResults.set(symbol, {
        providerCount: market.providerCount, providers: market.providers,
        conflicted: market.conflicted, rejectionCounts: market.rejectionCounts,
        providerErrorNames: (result.errors || []).map((error) => String(error).split(':')[0].slice(0, 40)),
      });
    }));
    if (finished) return;
    finished = true;
    const allKrakenAccepted = symbols.every((pair) => aggregationResults.get(pair.split('/')[0])?.providers.includes('Kraken'));
    finish(allKrakenAccepted ? 'PASS_PROVIDER_AGGREGATION_ONLY' : 'FAIL_OR_INCOMPLETE');
  } catch (error) {
    if (finished) return;
    finished = true;
    finish('FAIL_OR_INCOMPLETE', error);
  }
}
