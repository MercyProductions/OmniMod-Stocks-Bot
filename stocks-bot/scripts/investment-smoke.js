// Read-only public-data probe. Does not initialize Discord or write a journal.
import { fetchInvestmentResearch } from '../src/investmentResearch.js';

const symbols = (process.argv[2] || 'SPY,AAPL').split(',').slice(0, 5);
const report = await fetchInvestmentResearch(symbols, { maxSymbols: 5 });
console.log(JSON.stringify({
  fetchedAt: report.fetchedAt, provider: report.provider, benchmark: report.benchmark,
  rows: report.rows.map((row) => ({ symbol: row.symbol, decision: row.decision, sessions: row.sessions,
    asOf: row.asOf, expectedSession: row.expectedSession, horizon: row.horizon,
    historicalSamples: row.historical?.samples ?? null, reasons: row.reasons })),
  errors: report.errors
}, null, 2));
if (report.errors.length || !report.rows.length) process.exitCode = 1;
