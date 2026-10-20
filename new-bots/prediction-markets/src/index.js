import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appendPaperSnapshot } from '../../shared/paperJournal.js';
import { postDiscordWebhook } from '../../shared/discordWebhook.js';
import { askLevels, displayedSpreadWithFees, sizeCompleteSetToBudget } from './bookAnalysis.js';
import { reviewMarketMappings } from './mappingReview.js';

const env = (key, fallback) => process.env[key] ?? fallback;
const gamma = env('POLYMARKET_GAMMA_URL', 'https://gamma-api.polymarket.com');
const clob = env('POLYMARKET_CLOB_URL', 'https://clob.polymarket.com');
const kalshiApi = env('KALSHI_API_URL', 'https://external-api.kalshi.com/trade-api/v2');
const matchFile = env('KALSHI_MATCHES_FILE', 'kalshi-matches.json');
const limit = Math.max(1, Math.min(200, Number(env('MARKET_LIMIT', 80)) || 80));
const notional = Math.max(1, Number(env('NOTIONAL_USD', 25)) || 25);
const minEdge = Math.max(0, Number(env('MIN_GROSS_EDGE', 0.01)) || 0.01);
const minNetEdgePerShare = Math.max(0, Number(env('MIN_NET_EDGE_PER_SHARE', 0.005)) || 0.005);
const maxBookAgeMs = Math.max(1000, Number(env('MAX_BOOK_AGE_SECONDS', 10)) || 10) * 1000;
const minMakerSpreadCents = Math.max(0.1, Number(env('MIN_MAKER_SPREAD_CENTS', 3)) || 3);
const minTopSize = Math.max(1, Number(env('MIN_TOP_SIZE_SHARES', 25)) || 25);
const mappings = JSON.parse(await readFile(resolve(process.cwd(), matchFile), 'utf8'));
const mappingReviewMaxAgeDays = Math.max(1, Math.min(365, Number(env('MAPPING_REVIEW_MAX_AGE_DAYS', 30)) || 30));
const mappingReview = reviewMarketMappings(mappings, { maxAgeDays: mappingReviewMaxAgeDays });
const confirmedMappings = mappingReview.confirmed;

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Market data provider returned HTTP ${response.status}`);
  return response.json();
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value); } catch { return []; }
}

function timestampMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 1e12) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}
function freshBooks(books) {
  const stamps = books.map((book) => timestampMs(book?.timestamp));
  const now = Date.now();
  return stamps.every((time) => Number.isFinite(time) && time <= now + 1000 && now - time <= maxBookAgeMs)
    && Math.max(...stamps) - Math.min(...stamps) <= maxBookAgeMs;
}

const markets = await getJson(`${gamma}/markets?closed=false&limit=${limit}&order=volume24hr&ascending=false`);
if (!Array.isArray(markets)) throw new Error('Polymarket market discovery returned an unexpected response.');
const mappedSlugs = [...new Set(confirmedMappings.map((x) => x.polymarketSlug).filter(Boolean))];
for (const slug of mappedSlugs) {
  if (markets.some((x) => x.slug === slug)) continue;
  try {
    const found = await getJson(`${gamma}/markets?slug=${encodeURIComponent(slug)}`);
    if (Array.isArray(found)) markets.push(...found);
  } catch { /* An unavailable manual mapping is omitted for this scan. */ }
}
const polyBySlug = new Map(markets.map((market) => [market.slug, market]));
const results = [];
const spreadWatches = [];
const bookObservations = [];
const booksByToken = new Map();
let bookReadErrors = 0;
const bookReadErrorReasons = {};
function recordBookError(error) {
  bookReadErrors += 1;
  const message = String(error?.message || 'unknown error');
  const category = /HTTP (\d{3})/.exec(message)?.[0]
    || (/timeout/i.test(message) ? 'timeout' : /fetch|network|socket/i.test(message) ? 'network error' : 'provider response error');
  bookReadErrorReasons[category] = (bookReadErrorReasons[category] || 0) + 1;
}
async function getBook(tokenId) {
  if (!booksByToken.has(tokenId)) booksByToken.set(tokenId, getJson(`${clob}/book?token_id=${encodeURIComponent(tokenId)}`));
  return booksByToken.get(tokenId);
}

for (const market of markets) {
  const outcomes = parseArray(market.outcomes), tokens = parseArray(market.clobTokenIds);
  if (outcomes.length !== 2 || tokens.length !== 2 || market.closed || market.acceptingOrders === false) continue;
  let books;
  try { books = await Promise.all(tokens.map(getBook)); } catch (error) { recordBookError(error); continue; }
  const yesIndex = outcomes.findIndex((x) => /^yes$/i.test(x)), noIndex = outcomes.findIndex((x) => /^no$/i.test(x));
  if (yesIndex < 0 || noIndex < 0) continue;
  const yesBook = books[yesIndex], noBook = books[noIndex];
  const yesAsks = askLevels(yesBook), noAsks = askLevels(noBook);
  const isFresh = freshBooks(books);
  const feeConfig = { feesEnabled: market.feesEnabled, feeSchedule: market.feeSchedule };
  const yesSpread = displayedSpreadWithFees(yesBook, feeConfig), noSpread = displayedSpreadWithFees(noBook, feeConfig);
  if (isFresh && [yesSpread, noSpread].some((x) => x && x.netDisplayedSpreadCents !== null && x.netDisplayedSpreadCents >= minMakerSpreadCents && x.visibleTwoSidedSize >= minTopSize)) {
    spreadWatches.push({ venue: 'Polymarket', question: market.question, slug: market.slug, yes: yesSpread, no: noSpread,
      observedAt: new Date().toISOString(), warning: 'Displayed spread and size only; maker fills are uncertain, inventory can accumulate, and fees/adverse selection are not included.' });
  }
  const bestYes = yesAsks[0], bestNo = noAsks[0];
  if (bestYes && bestNo) bookObservations.push({ marketId: market.id, slug: market.slug, question: market.question, yesBestAsk: yesAsks[0].price, yesBestAskSize: yesAsks[0].size, noBestAsk: noAsks[0].price, noBestAskSize: noAsks[0].size, grossCompleteSetCostPerShare: yesAsks[0].price + noAsks[0].price, marketFeesEnabled: market.feesEnabled ?? null, marketFeeSchedule: market.feeSchedule ?? null, yesDisplayedSpread: yesSpread, noDisplayedSpread: noSpread, freshBooks: isFresh, yesTimestamp: yesBook.timestamp ?? null, noTimestamp: noBook.timestamp ?? null, endDate: market.endDate, observedAt: new Date().toISOString() });
  if (!(bestYes && bestNo) || !isFresh) continue;
  const completeSet = sizeCompleteSetToBudget(yesBook, noBook, notional, feeConfig, { minOrderUsd: Number(market.orderMinSize) || 0 });
  if (!completeSet) continue;
  const grossEdgePerShare = completeSet.grossProfitUsd / completeSet.shares;
  const netEdgePerShare = completeSet.netProfitUsd / completeSet.shares;
  if (netEdgePerShare >= minNetEdgePerShare && grossEdgePerShare >= minEdge) results.push({
    venue: 'Polymarket', question: market.question, slug: market.slug, endDate: market.endDate,
    shares: Number(completeSet.shares.toFixed(5)), cashBudgetUsd: notional,
    estimatedGrossPairCostUsd: Number(completeSet.grossPairCostUsd.toFixed(5)), estimatedFeeUsd: Number(completeSet.totalFeeUsd.toFixed(5)),
    estimatedAllInCostUsd: Number(completeSet.totalCostUsd.toFixed(5)), estimatedNetProfitUsd: Number(completeSet.netProfitUsd.toFixed(5)),
    grossEdgePerShare: Number(grossEdgePerShare.toFixed(5)), netEdgePerShare: Number(netEdgePerShare.toFixed(5)),
    feeBasis: market.feesEnabled ? 'market-specific taker fee schedule applied to visible ask depth' : 'market fee flag disabled',
    observedAt: new Date().toISOString(),
    warning: 'Net of configured market taker fees and visible ask-depth cost; excludes settlement, redemption timing, gas/bridge/funding costs, quote changes and fill risk.'
  });
}

if (confirmedMappings.length) {
  const tickers = [...new Set(confirmedMappings.map((x) => x.kalshiTicker).filter(Boolean))];
  const listed = await getJson(`${kalshiApi}/markets?tickers=${encodeURIComponent(tickers.join(','))}&mve_filter=exclude`);
  const kalshiByTicker = new Map((listed.markets || []).map((market) => [market.ticker, market]));
  for (const mapping of confirmedMappings) {
    const poly = polyBySlug.get(mapping.polymarketSlug), kalshi = kalshiByTicker.get(mapping.kalshiTicker);
    if (!poly || !kalshi || kalshi.status !== 'open' || kalshi.market_type !== 'binary') continue;
    const outcomes = parseArray(poly.outcomes), tokens = parseArray(poly.clobTokenIds);
    const yesIndex = outcomes.findIndex((x) => /^yes$/i.test(x)), noIndex = outcomes.findIndex((x) => /^no$/i.test(x));
    if (yesIndex < 0 || noIndex < 0) continue;
    let yesBook, noBook;
    try { [yesBook, noBook] = await Promise.all([getBook(tokens[yesIndex]), getBook(tokens[noIndex])]); } catch (error) { recordBookError(error); continue; }
    if (!freshBooks([yesBook, noBook])) continue;
    const pyAsk = askLevels(yesBook)[0], pnAsk = askLevels(noBook)[0];
    const py = Number(pyAsk?.price), pn = Number(pnAsk?.price);
    const ky = Number(kalshi.yes_ask_dollars), kn = Number(kalshi.no_ask_dollars);
    const size = Math.min(Number(pyAsk?.size), Number(pnAsk?.size), Number(kalshi.yes_ask_size_fp ?? kalshi.yes_ask_size), Number(kalshi.no_ask_size_fp ?? kalshi.no_ask_size));
    if (!(size > 0 && py > 0 && pn > 0 && ky > 0 && kn > 0)) continue;
    for (const pair of [
      { buyYesAt: 'Polymarket', yes: py, buyNoAt: 'Kalshi', no: kn },
      { buyYesAt: 'Kalshi', yes: ky, buyNoAt: 'Polymarket', no: pn }
    ]) {
      const costPerShare = pair.yes + pair.no, edge = 1 - costPerShare;
      if (edge >= minEdge) results.push({
        venue: 'Cross-platform', question: poly.question, polymarketSlug: poly.slug, kalshiTicker: kalshi.ticker,
        buyYesAt: pair.buyYesAt, buyNoAt: pair.buyNoAt, topAskShares: size,
        estimatedGrossCostPerPair: Number(costPerShare.toFixed(5)), grossEdgePerShare: Number(edge.toFixed(5)),
        observedAt: new Date().toISOString(), rulesReviewedAt: mapping.reviewedAt,
        warning: 'Manual rule match; top-of-book only; before fees and fill/settlement risks. Verify current rules and prices.'
      });
    }
  }
}

const journal = await appendPaperSnapshot('prediction-markets', bookObservations, { strategies: ['binary complete-set gross screen', 'displayed spread watch'], threshold: minEdge, minMakerSpreadCents, minTopSize, maxBookAgeMs, kalshiMappingsChecked: confirmedMappings.length });
const clean = (value) => String(value).replace(/[\r\n@`]/g, ' ');
const lines = [
  ...results.slice(0, 4).map((x) => x.venue === 'Polymarket'
    ? `${clean(x.question)} | estimated net $${x.estimatedNetProfitUsd} on $${x.cashBudgetUsd} | net/share $${x.netEdgePerShare}`
    : `${clean(x.question)} | gross edge/share $${x.grossEdgePerShare} | fees unverified | ${x.venue}`),
  ...spreadWatches.slice(0, 2).map((x) => {
    const widths = [x.yes && `YES ${x.yes.spreadCents.toFixed(1)}¢ / ${x.yes.visibleTwoSidedSize.toFixed(0)} sh`, x.no && `NO ${x.no.spreadCents.toFixed(1)}¢ / ${x.no.visibleTwoSidedSize.toFixed(0)} sh`].filter(Boolean).join('; ');
    return `${clean(x.question)} | paper spread watch ${widths}`;
  })
];
const mappingNote = mappingReview.expired.length ? `${mappingReview.expired.length} mapping(s) require renewed rules review.` : '';
const dedupeKey = JSON.stringify({ mappingReview: mappingReview.expired.length, completeSets: results.map((x) => `${x.venue}:${x.slug || x.kalshiTicker}:${Math.round((x.netEdgePerShare ?? x.grossEdgePerShare) * 1000)}`).sort(), spreads: spreadWatches.map((x) => x.slug).sort() });
const delivery = await postDiscordWebhook(['OmniMod Prediction Markets · read-only research', `${markets.length} markets scanned · ${confirmedMappings.length} current manual Kalshi mappings · ${new Date().toISOString()}`, mappingNote, ...(lines.length ? lines : ['No fresh gross complete-set screen passed the configured threshold.']), 'Displayed spread is not profit: fills, fees, inventory risk, and adverse selection are not modeled.'].filter(Boolean).join('\n'), { dedupeKey });
console.log(JSON.stringify({ bot: 'prediction-markets', mode: 'read-only research', scannedPolymarketMarkets: markets.length, confirmedKalshiMappings: confirmedMappings.length, expiredKalshiMappings: mappingReview.expired.length, unreviewedKalshiMappings: mappingReview.unreviewed.length, mappingReviewMaxAgeDays, minGrossEdgePerShare: minEdge, minNetEdgePerShare, bookReadErrors, bookReadErrorReasons, candidates: results, marketMakingSpreadWatches: spreadWatches, paperJournal: journal, discordDelivery: delivery }, null, 2));
