import { writeFile } from 'node:fs/promises';
import { fetchHistoricalCandles } from '../src/marketProviders.js';
import { analyzeInvestment, evaluateInvestmentHorizons } from '../src/investmentResearch.js';

// Public price data only. No Discord imports, credentials, orders, or messages.
const assets = [{ id: 'bitcoin', symbol: 'BTC' }, { id: 'ethereum', symbol: 'ETH' }];
const histories = [];
for (const asset of assets) histories.push(await fetchHistoricalCandles(asset, { interval: '1d', limit: 720, force: true }));
const report = assets.map((asset, index) => {
  const history = histories[index];
  const horizons = evaluateInvestmentHorizons(history.candles, histories[0].candles);
  const analysis = analyzeInvestment(asset, history.candles, histories[0].candles);
  return { symbol: asset.symbol, provider: history.provider || 'unavailable', interval: history.interval || '1d',
    completedBars: history.candles.length, lastDailyCloseAt: history.candles.length ? new Date(history.candles.at(-1).time + 86400000).toISOString() : null,
    providerErrors: history.errors.map((error) => String(error).slice(0, 250)),
    horizonSamples: horizons.map((row) => ({ horizonDays: row.horizonDays, samples: row.samples, assessment: row.evidence })),
    decision: analysis.decision, reasons: analysis.reasons };
});
const payload = { checkedAt: new Date().toISOString(), purpose: 'Capped BTC/ETH public daily-data smoke test; liquidity snapshot intentionally absent, so no investment qualification.', report };
await writeFile(new URL('../DAILY_DATA_SMOKE.md', import.meta.url), `# Public daily-data smoke test\n\nNo bot login, trade, or Discord message was made. Public provider limits and availability can change. This is a plumbing check, not investment evidence.\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`);
console.log(JSON.stringify(payload, null, 2));
