import { createHash } from 'node:crypto';
import { config } from '../src/config.js';
import { DEFAULT_WATCHLIST } from '../src/guildSettings.js';
import { recordMarketBars } from '../src/researchStore.js';
import { paths, readJson, writeJson } from '../src/storage.js';
import { requestAlpacaBackfillJson } from '../src/alpacaBackfillRequest.js';
import { hashAlpacaPageToken, inspectAlpacaBackfillCheckpoint, normalizeAlpacaBackfillPage } from '../src/alpacaBackfillPage.js';
import { acquireBackfillCheckpointLock } from '../src/backfillCheckpointLock.js';

function argument(name, fallback = '') {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function iso(value, fallback) {
  const date = new Date(value || fallback);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date.toISOString();
}

if (!config.alpacaKeyId || !config.alpacaSecretKey) {
  throw new Error('ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY are required for historical backfill.');
}

const requestedSymbols = argument('symbols');
const symbols = [...new Set((requestedSymbols ? requestedSymbols.split(/[\s,;]+/) : DEFAULT_WATCHLIST)
  .map((value) => value.trim().toUpperCase()).filter((value) => /^[A-Z][A-Z0-9.-]{0,10}$/.test(value)))];
if (!symbols.length) throw new Error('At least one valid historical backfill symbol is required.');
const timeframe = argument('timeframe', '15Min');
if (!['1Min', '5Min', '15Min', '1Hour', '1Day'].includes(timeframe)) throw new Error('timeframe must be 1Min, 5Min, 15Min, 1Hour, or 1Day.');
const feed = argument('feed', config.alpacaDataFeed);
if (!['iex', 'sip', 'delayed_sip'].includes(feed)) throw new Error('feed must be iex, sip, or delayed_sip.');
const end = iso(argument('end'), new Date());
const start = iso(argument('start'), new Date(new Date(end).getTime() - 730 * 24 * 60 * 60_000));
if (Date.parse(end) <= Date.parse(start)) throw new Error('Historical backfill end must be after start.');
const signature = JSON.stringify({ symbols, timeframe, feed, start, end });
const checkpointId = `alpaca-${createHash('sha256').update(signature).digest('hex').slice(0, 16)}`;
const checkpointFile = paths.researchCheckpoint(checkpointId);
const releaseCheckpointLock = await acquireBackfillCheckpointLock(checkpointFile);
try {
const missingCheckpoint = { __missingCheckpoint: true };
const savedCheckpoint = await readJson(checkpointFile, missingCheckpoint);
const checkpoint = savedCheckpoint === missingCheckpoint ? { version: 2, signature: null, pages: 0, bars: 0, nextPageToken: '', seenPageTokenHashes: [],
  lastTimestampBySymbol: {}, coverageBySymbol: Object.fromEntries(symbols.map((symbol) => [symbol, { bars: 0, firstTimestamp: null, lastTimestamp: null }])), completed: false } : savedCheckpoint;

const checkpointState = inspectAlpacaBackfillCheckpoint(checkpoint, { signature, symbols });
const { legacyPriorCoverageUnknown, lastTimestampBySymbol, coverageBySymbol, seenPageTokenHashes } = checkpointState;

if (checkpoint.completed) {
  console.log(`Backfill ${checkpointId} is already complete (${checkpoint.bars} bars). Change the requested range/symbols to create a new dataset slice.`);
} else {

let nextPageToken = checkpoint.nextPageToken || '';
let pages = Number(checkpoint.pages) || 0;
let totalBars = Number(checkpoint.bars) || 0;
const seenPageTokenHashSet = new Set(seenPageTokenHashes);
do {
  if (nextPageToken && seenPageTokenHashSet.has(hashAlpacaPageToken(nextPageToken))) {
    throw new Error('Alpaca pagination token repeated; backfill stopped before marking the dataset complete.');
  }
  if (nextPageToken) seenPageTokenHashSet.add(hashAlpacaPageToken(nextPageToken));
  const query = new URLSearchParams({
    symbols: symbols.join(','), timeframe, start, end, adjustment: 'all', feed, sort: 'asc', limit: '10000'
  });
  if (nextPageToken) query.set('page_token', nextPageToken);
  const data = await requestAlpacaBackfillJson(`https://data.alpaca.markets/v2/stocks/bars?${query}`, {
    keyId: config.alpacaKeyId, secretKey: config.alpacaSecretKey,
  });
  const page = normalizeAlpacaBackfillPage(data, { symbols, start, end, lastTimestampBySymbol });
  if (page.nextPageToken && (seenPageTokenHashSet.has(hashAlpacaPageToken(page.nextPageToken))
    || page.nextPageToken === nextPageToken)) throw new Error('Alpaca pagination token repeated; backfill stopped before marking the dataset complete.');
  const rows = page.rows;
  for (const row of rows) {
    const coverage = coverageBySymbol[row.symbol];
    if (!coverage) throw new Error(`Backfill coverage checkpoint is missing ${row.symbol}.`);
    coverage.bars += 1;
    coverage.firstTimestamp ??= row.timestamp;
    coverage.lastTimestamp = row.timestamp;
  }
  await recordMarketBars(`alpaca-${feed}-${timeframe.toLowerCase()}`, rows);
  pages += 1;
  totalBars += rows.length;
  nextPageToken = page.nextPageToken;
  Object.assign(lastTimestampBySymbol, page.lastTimestampBySymbol);
  await writeJson(checkpointFile, {
    version: 2, checkpointId, signature,
    pages, bars: totalBars, nextPageToken, seenPageTokenHashes: [...seenPageTokenHashSet], lastTimestampBySymbol, coverageBySymbol,
    ...(legacyPriorCoverageUnknown ? { priorCoverageStatus: 'unknown_legacy_checkpoint' } : {}),
    completed: !nextPageToken, updatedAt: new Date().toISOString()
  });
  console.log(`Stored page ${pages}: ${rows.length} bars (${totalBars} total).`);
} while (nextPageToken);

const symbolsWithBars = Object.entries(coverageBySymbol).filter(([, coverage]) => Number(coverage?.bars) > 0).map(([symbol]) => symbol);
console.log(JSON.stringify({ backfillComplete: true, checkpointId, timeframe, feed, start, end, pages, bars: totalBars,
  requestedSymbols: symbols.length, symbolsWithBarsInValidatedPages: symbolsWithBars.length,
  symbolsWithoutBarsInValidatedPages: Object.keys(coverageBySymbol).filter((symbol) => !symbolsWithBars.includes(symbol)),
  coverageBySymbol, coverageStatus: legacyPriorCoverageUnknown ? 'partial; version-1 checkpoint had no per-symbol coverage' : 'observed provider rows only; trading-session completeness is not inferred' }, null, 2));
}
} finally {
  await releaseCheckpointLock();
}

