import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlpacaRequestGate } from '../src/alpacaRequestGate.js';
import { completedAdjustedDailyBars, analyzeInvestment, annualizedMetricGrowth, classifyBenchmarkRegime, estimateAnnualTradingMultiples, estimateHistoricalAnnualMultiples, summarizeHistoricalAnnualMultiples, historicalDailyEvidence, fetchInvestmentResearch, investmentResearchText } from '../src/investmentResearch.js';
import { buildCommands } from '../src/commands.js';

function history(growth = 0.001, length = 600) {
  const rows = []; const date = new Date('2024-01-02T15:00:00Z');
  while (rows.length < length) {
    if (![0, 6].includes(date.getUTCDay())) {
      const price = 100 * Math.exp(growth * rows.length);
      rows.push({ timestamp: date.getTime() / 1000, date: date.toISOString().slice(0, 10), open: price * 0.999, high: price * 1.01, low: price * 0.99, close: price, rawClose: price, dollarVolume: 100_000_000 });
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return rows;
}
function chart(rows) {
  return { timestamp: rows.map((b) => b.timestamp), indicators: { quote: [{ open: rows.map((b) => b.open), high: rows.map((b) => b.high), low: rows.map((b) => b.low), close: rows.map((b) => b.rawClose), volume: rows.map(() => 1_000_000) }], adjclose: [{ adjclose: rows.map((b) => b.close) }] } };
}
function alpacaPayload(rows) {
  const raw = chart(rows), quote = raw.indicators.quote[0];
  return { bars: Object.fromEntries([['SPY', rows]].map(([symbol, values]) => [symbol, values.map((bar, i) => ({
    t: new Date(bar.timestamp * 1000).toISOString(), o: quote.open[i], h: quote.high[i], l: quote.low[i], c: quote.close[i], v: quote.volume[i]
  }))])) };
}

test('benchmark regime is descriptive, uses only completed history, and remains unknown with insufficient data', () => {
  const rising = history(0.002, 600), falling = history(-0.002, 600), flat = history(0, 600);
  const risingRegime = classifyBenchmarkRegime(rising);
  assert.equal(risingRegime.label, 'risk_on');
  assert.equal(classifyBenchmarkRegime(falling).label, 'risk_off');
  assert.equal(classifyBenchmarkRegime(flat).label, 'mixed');
  assert.equal(classifyBenchmarkRegime(rising.slice(-200)).label, 'insufficient_history');
  assert.match(risingRegime.method, /not used to alter asset scores/i);
  assert.equal(risingRegime.volatilityRegime, 'typical');
  assert.equal(risingRegime.volatilityPercentile, 50);
  assert.ok(Number.isFinite(risingRegime.annualizedVolatilityPct));
  assert.equal(risingRegime.drawdownFrom252ObservationPeakPct, 0);
  const volatile = history(0.001, 600);
  for (let index = volatile.length - 20; index < volatile.length; index += 1)
    volatile[index].close = volatile[index - 1].close * (index % 2 ? 1.05 : 0.95);
  const volatileRegime = classifyBenchmarkRegime(volatile);
  assert.ok(volatileRegime.volatilityPercentile >= 90);
  assert.equal(volatileRegime.volatilityRegime, 'extreme');
  assert.match(volatileRegime.method, /No macro, breadth, or credit data/);
});

test('daily normalization requires adjustments and excludes unfinished and malformed candles', () => {
  const rows = history(0.001, 3); const raw = chart(rows);
  const now = new Date(rows[2].timestamp * 1000);
  assert.equal(completedAdjustedDailyBars(raw, now).length, 2);
  raw.indicators.quote[0].open[0] = null;
  assert.equal(completedAdjustedDailyBars(raw, now).length, 1);
  raw.indicators.adjclose = [];
  assert.equal(completedAdjustedDailyBars(raw, now).length, 0);
});

test('OHLC is adjusted consistently while liquidity uses raw traded dollars', () => {
  const row = history(0, 1)[0]; const raw = chart([row]);
  raw.indicators.adjclose[0].adjclose[0] = 50;
  const [adjusted] = completedAdjustedDailyBars(raw, new Date('2026-09-18T22:00:00Z'));
  assert.equal(adjusted.close, 50);
  assert.equal(adjusted.open, row.open / 2);
  assert.equal(adjusted.dollarVolume, 100_000_000);
});

test('investment research keeps 5/20/60-day rank separate from multi-year price context', () => {
  const stock = history(0.002), spy = history(0.001);
  const now = new Date(`${stock.at(-1).date}T22:00:00Z`);
  for (const horizon of [5, 20, 60]) {
    const result = analyzeInvestment('AAPL', stock, spy, { now, horizon });
    assert.equal(result.decision, 'RESEARCH_CANDIDATE');
    assert.ok(result.relativeReturns[horizon] > 0);
    assert.equal(result.horizon, horizon);
    assert.equal(result.probability, undefined);
    assert.ok(result.historical.samples > 0);
  }
  const text = investmentResearchText({ rows: [{ symbol: 'AAPL', decision: 'RESEARCH_CANDIDATE', horizon: 20, score: 75,
    asOf: '2026-09-24', relativeReturns: { 20: 1 }, absoluteReturns: { 5: 1, 20: 2, 60: 4 }, trendPersistence: 80,
    longTermPriceContext: [{ label: 'about 1 year', status: 'observed', assetAdjustedReturnPct: 20, excessAdjustedReturnPct: 5 }],
    drawdownPct: -5, historical: null, reasons: [], eventRiskNotes: [] }], errors: [] });
  assert.match(text, /Long-horizon adjusted-price context.*about 1 year 20.0% \/ 5.0 pp/);
  assert.match(text, /no multi-year thesis, intrinsic\/fair value, personal portfolio review, or buy instruction/i);
});

test('multi-year stock returns require complete aligned sessions and do not alter the daily decision', () => {
  const stock = history(0.0015, 1300), spy = history(0.001, 1300);
  const now = new Date(`${stock.at(-1).date}T22:00:00Z`);
  const full = analyzeInvestment('AAPL', stock, spy, { now, horizon: 20 });
  const shorter = analyzeInvestment('AAPL', stock.slice(-600), spy.slice(-600), { now, horizon: 20 });
  assert.equal(full.decision, shorter.decision);
  assert.equal(full.score, shorter.score);
  assert.equal(full.longTermPriceContext.find((row) => row.sessions === 1250).status, 'observed');
  assert.equal(shorter.longTermPriceContext.find((row) => row.sessions === 1250).status, 'insufficient_history');
  assert.ok(full.longTermPriceContext.find((row) => row.sessions === 252).excessAdjustedReturnPct > 0);
  const gapped = stock.filter((_, index) => index !== 500);
  const incomplete = analyzeInvestment('AAPL', gapped, spy, { now, horizon: 20 });
  assert.ok(incomplete.longTermPriceContext.every((row) => row.status === 'incomplete_alignment'));
});

test('annual price multiples use period-aligned facts and dated shares without changing the score', () => {
  const fundamentals = { status: 'partial', filing: { form: '10-K', filedAt: '2026-02-15', periodEnd: '2025-12-31' }, metrics: {
    sharesOutstanding: { value: 500_000_000, unit: 'shares', periodEnd: '2025-12-31' },
    revenue: { value: 1_100_000_000, unit: 'USD', periodEnd: '2025-12-31' },
    netIncome: { value: 120_000_000, unit: 'USD', periodEnd: '2025-12-31' },
    freeCashFlow: { value: 135_000_000, unit: 'USD', periodEnd: '2025-12-31' }
  } };
  const value = estimateAnnualTradingMultiples(10, '2026-09-23', fundamentals);
  assert.equal(value.status, 'estimated');
  assert.equal(value.marketCapEstimate, 5_000_000_000);
  assert.ok(Math.abs(value.priceToSales - 5_000_000_000 / 1_100_000_000) < 1e-12);
  assert.ok(Math.abs(value.priceToEarnings - (5_000_000_000 / 120_000_000)) < 1e-12);
  assert.ok(Math.abs(value.priceToFreeCashFlow - (5_000_000_000 / 135_000_000)) < 1e-12);
  assert.ok(Math.abs(value.freeCashFlowYieldPct - 2.7) < 1e-12);
  assert.equal(estimateAnnualTradingMultiples(10, '2026-09-23', fundamentals, { postFilingSplit: true }).status, 'unavailable');
  assert.equal(estimateAnnualTradingMultiples(10, '2026-09-23', { ...fundamentals, filing: { ...fundamentals.filing, form: '20-F' } }).status, 'unavailable');
  assert.equal(estimateAnnualTradingMultiples(10, '2026-02-15', fundamentals).status, 'unavailable');
  assert.equal(estimateAnnualTradingMultiples(10, '2026-09-23', { ...fundamentals, metrics: { ...fundamentals.metrics,
    sharesOutstanding: { value: 500_000_000, unit: 'shares', periodEnd: '2024-01-01' } } }).status, 'unavailable');
  const missingCashFlow = estimateAnnualTradingMultiples(10, '2026-09-23', { ...fundamentals, metrics: { ...fundamentals.metrics,
    freeCashFlow: { value: null, unit: 'USD', periodEnd: '2025-12-31' } } });
  assert.equal(missingCashFlow.priceToFreeCashFlow, null);
  assert.equal(missingCashFlow.freeCashFlowYieldPct, null);
});

test('historical annual multiples pair exact filing facts with the first later raw close and withhold split periods', () => {
  const inputs = [
    { filing: { form: '10-K', filedAt: '2023-02-10', periodEnd: '2022-12-31' },
      revenue: { value: 1000, unit: 'USD', periodEnd: '2022-12-31' }, netIncome: { value: 100, unit: 'USD', periodEnd: '2022-12-31' },
      freeCashFlow: { value: 100, unit: 'USD', periodEnd: '2022-12-31' }, sharesOutstanding: { value: 100, unit: 'shares', periodEnd: '2022-12-31' } },
    { filing: { form: '10-K', filedAt: '2024-02-10', periodEnd: '2023-12-31' },
      revenue: { value: 1000, unit: 'USD', periodEnd: '2023-12-31' }, netIncome: { value: 100, unit: 'USD', periodEnd: '2023-12-31' },
      freeCashFlow: { value: 100, unit: 'USD', periodEnd: '2023-12-31' }, sharesOutstanding: { value: 100, unit: 'shares', periodEnd: '2023-12-31' } },
    { filing: { form: '10-K', filedAt: '2025-02-10', periodEnd: '2024-12-31' },
      revenue: { value: 1000, unit: 'USD', periodEnd: '2024-12-31' }, netIncome: { value: 100, unit: 'USD', periodEnd: '2024-12-31' },
      freeCashFlow: { value: 100, unit: 'USD', periodEnd: '2024-12-31' }, sharesOutstanding: { value: 100, unit: 'shares', periodEnd: '2024-12-31' } }
  ];
  const bars = [
    { date: '2022-12-30', rawClose: 9, close: 90 },
    { date: '2023-02-10', rawClose: 999, close: 999 }, { date: '2023-02-13', rawClose: 10, close: 100 },
    { date: '2024-02-12', rawClose: 20, close: 200 }, { date: '2025-02-11', rawClose: 30, close: 300 }
  ];
  const observations = estimateHistoricalAnnualMultiples(bars, inputs, [], '2025-02-11');
  assert.equal(observations.length, 3);
  assert.equal(observations[0].priceAsOf, '2023-02-13');
  assert.equal(observations[0].marketCapEstimate, 1000);
  assert.equal(observations[0].priceToSales, 1);
  assert.equal(observations[0].priceToEarnings, 10);
  assert.equal(observations[0].priceToFreeCashFlow, 10);
  assert.equal(summarizeHistoricalAnnualMultiples(observations).priceToSales.sampleSize, 3);
  assert.equal(summarizeHistoricalAnnualMultiples(observations).priceToSales.min, 1);
  assert.equal(summarizeHistoricalAnnualMultiples(observations).priceToSales.max, 3);

  const split = estimateHistoricalAnnualMultiples(bars, inputs, [{ type: 'split', date: '2023-02-11' }], '2025-02-11');
  assert.equal(split[0].status, 'unavailable');
  assert.match(split[0].reason, /split/);
  assert.equal(split[1].status, 'estimated');
  const noPostFilingBar = estimateHistoricalAnnualMultiples(bars.slice(0, 1), inputs.slice(0, 1), [], '2023-02-10');
  assert.equal(noPostFilingBar[0].status, 'unavailable');
  assert.match(noPostFilingBar[0].reason, /after the filing date/);
  const incompleteCorporateActionCoverage = estimateHistoricalAnnualMultiples(bars.slice(1), inputs.slice(0, 1), [], '2023-02-13');
  assert.equal(incompleteCorporateActionCoverage[0].status, 'unavailable');
  assert.match(incompleteCorporateActionCoverage[0].reason, /predates the available price and corporate-action history/);
});

test('annualized SEC growth requires three positive, consecutive annual observations', () => {
  const history = [
    { periodEnd: '2023-12-31', value: 900 }, { periodEnd: '2024-12-31', value: 1000 }, { periodEnd: '2025-12-31', value: 1100 }
  ];
  const result = annualizedMetricGrowth(history);
  assert.equal(result.periods, 3);
  assert.equal(result.from, '2023-12-31');
  assert.equal(result.through, '2025-12-31');
  assert.ok(Math.abs(result.pct - (Math.pow(1100 / 900, 365.2425 / (365 + 366)) - 1) * 100) < 1e-9);
  const latestThree = annualizedMetricGrowth([{ periodEnd: '2022-12-31', value: 800 }, ...history]);
  assert.equal(latestThree.from, '2023-12-31');
  assert.equal(latestThree.pct, result.pct);
  assert.equal(annualizedMetricGrowth(history.slice(1)), null);
  assert.equal(annualizedMetricGrowth([...history.slice(0, 2), { periodEnd: '2025-12-31', value: -1 }]), null);
  assert.equal(annualizedMetricGrowth([history[0], { periodEnd: '2024-06-30', value: 1000 }, history[2]]), null);
});

test('research text shows SEC filing date, annual reported facts, provenance and unavailable limits', () => {
  const row = { symbol: 'AAPL', decision: 'WATCH_ONLY', horizon: 20, score: 61, asOf: '2026-09-23',
    relativeReturns: { 20: -1 }, absoluteReturns: { 5: 0, 20: 1, 60: 2 }, trendPersistence: 50,
    drawdownPct: -8, historical: null, reasons: [], eventRiskNotes: [], annualFundamentals: {
      status: 'partial', filing: { form: '10-K', filedAt: '2026-02-15', periodEnd: '2025-12-31', url: 'https://www.sec.gov/Archives/edgar/data/123/annual.htm' },
      metrics: {
        revenue: { value: 1100, unit: 'USD', growthPct: 10, history: [
          { periodEnd: '2025-12-31', value: 1100 }, { periodEnd: '2024-12-31', value: 1000 }, { periodEnd: '2023-12-31', value: 900 }
        ] }, grossProfit: { value: 660, unit: 'USD', history: [
          { periodEnd: '2025-12-31', value: 660 }, { periodEnd: '2024-12-31', value: 600 }, { periodEnd: '2023-12-31', value: 540 }
        ] }, grossMarginPct: { value: 60, unit: 'percent' }, netIncome: { value: 120, unit: 'USD' },
        operatingIncome: { value: 220, unit: 'USD' }, interestExpense: { value: 55, unit: 'USD' }, interestCoverageRatio: { value: 4, unit: 'x' },
        debtMaturityNext12Months: { value: 30, unit: 'USD' }, debtMaturityYearTwo: { value: 25, unit: 'USD' },
        debtMaturityYearThree: { value: null, unit: 'USD' }, debtMaturityYearFour: { value: null, unit: 'USD' },
        debtMaturityYearFive: { value: null, unit: 'USD' }, debtMaturityAfterYearFive: { value: 100, unit: 'USD' },
        operatingMarginPct: { value: 20, unit: 'percent' }, netMarginPct: { value: 10.9, unit: 'percent' },
        freeCashFlowMarginPct: { value: 12.3, unit: 'percent' }, currentAssets: { value: 800, unit: 'USD' },
        currentLiabilities: { value: 400, unit: 'USD' }, workingCapital: { value: 400, unit: 'USD' }, currentRatio: { value: 2, unit: 'x' },
        accountsReceivable: { value: 180, unit: 'USD', history: [{ periodEnd: '2025-12-31', value: 180 }, { periodEnd: '2024-12-31', value: 150 }] },
        inventory: { value: 90, unit: 'USD', history: [{ periodEnd: '2025-12-31', value: 90 }, { periodEnd: '2024-12-31', value: 95 }] },
        receivablesRevenueGrowthGapPp: { value: 10, unit: 'percentage_points' },
        cashLessLongTermDebt: { value: 50, unit: 'USD' },
        operatingCashFlow: { value: 180, unit: 'USD' }, operatingCashConversion: { value: 1.5, unit: 'x', history: [
          { periodEnd: '2025-12-31', value: 1.5 }, { periodEnd: '2024-12-31', value: 1.2 }, { periodEnd: '2023-12-31', value: 1.1 }
        ] }, capitalExpenditure: { value: -45, unit: 'USD' },
        freeCashFlow: { value: 135, unit: 'USD', history: [
          { periodEnd: '2025-12-31', value: 135 }, { periodEnd: '2024-12-31', value: 120 }, { periodEnd: '2023-12-31', value: 100 }
        ] }, cash: { value: 300, unit: 'USD' },
        longTermDebtCurrent: { value: 40, unit: 'USD' }, longTermDebtNoncurrent: { value: 210, unit: 'USD' },
        sharesOutstanding: { value: 500_000_000, unit: 'shares' }, weightedAverageDilutedShares: { value: 520_000_000, unit: 'shares', growthPct: 4, history: [
          { periodEnd: '2025-12-31', value: 520_000_000 }, { periodEnd: '2024-12-31', value: 500_000_000 }, { periodEnd: '2023-12-31', value: 490_000_000 }
        ] }, dilutedEps: { value: 2.4, unit: 'USD/shares', history: [
          { periodEnd: '2025-12-31', value: 2.4 }, { periodEnd: '2024-12-31', value: 2 }, { periodEnd: '2023-12-31', value: 1.8 }
        ] }
      }
    }, annualValuation: { status: 'estimated', price: 10, marketCapEstimate: 5_000_000_000, priceAsOf: '2026-09-23', shareCountAsOf: '2025-12-31',
      annualPeriodEnd: '2025-12-31', priceToSales: 4.54545454545, priceToEarnings: 41.6666666667,
      priceToFreeCashFlow: 37.037037037, freeCashFlowYieldPct: 2.7,
      limitations: ['Estimate uses last raw close and filing-date shares.', 'Annual ratios are backward-looking.', 'Not intrinsic value.'] },
    historicalValuations: [
      { status: 'estimated', fiscalYear: '2023', priceAsOf: '2024-02-12', priceToSales: 3, priceToEarnings: 30, priceToFreeCashFlow: 15 },
      { status: 'estimated', fiscalYear: '2024', priceAsOf: '2025-02-11', priceToSales: 4, priceToEarnings: 40, priceToFreeCashFlow: 20 },
      { status: 'estimated', fiscalYear: '2025', priceAsOf: '2026-02-17', priceToSales: 5, priceToEarnings: 50, priceToFreeCashFlow: 25 }
    ], historicalValuationSummary: {
      priceToSales: { sampleSize: 3, min: 3, max: 5 }, priceToEarnings: { sampleSize: 3, min: 30, max: 50 },
      priceToFreeCashFlow: { sampleSize: 3, min: 15, max: 25 }
    } };
  const text = investmentResearchText({ rows: [row], errors: [] });
  assert.match(text, /SEC annual fundamentals \(10-K; filed 2026-02-15; FY end 2025-12-31\)/);
  assert.match(text, /revenue \$1,100/);
  assert.match(text, /gross profit \$660/);
  assert.match(text, /gross\/operating\/net\/FCF margins 60\.0% \/ 20\.0% \/ 10\.9% \/ 12\.3%/);
  assert.match(text, /ROE\/ROA \(net income ÷ average balance\) unavailable \/ unavailable/);
  assert.match(text, /Indicative backward-looking annual multiples: implied market cap \$5B \| P\/S 4\.5x \| P\/E 41\.7x \| price\/FCF 37\.0x \| FCF yield 2\.70%/);
  assert.match(text, /Historical 10-K multiples \(exact filing facts; first later close; observed, not fair value\)/);
  assert.match(text, /sample ranges: P\/S 3\.0–5\.0x \(n=3\) \| P\/E 30\.0–50\.0x \(n=3\) \| P\/FCF 15\.0–25\.0x \(n=3\)/i);
  assert.match(text, /calculated FCF \$135/);
  assert.match(text, /operating income \/ interest expense \$220 \/ \$55; simplified coverage 4\.00x/);
  assert.match(text, /reported principal maturity ladder \(next 12 mo \/ years 2 \/ 3 \/ 4 \/ 5 \/ after 5\) \$30 \/ \$25 \/ unavailable \/ unavailable \/ unavailable \/ \$100/);
  assert.match(text, /OCF\/net income 1\.50x/);
  assert.match(text, /receivables \$180/);
  assert.match(text, /inventory \$90/);
  assert.match(text, /receivables growth minus revenue growth \+10\.0 pp/);
  assert.match(text, /receivables 2024 \$150 → 2025 \$180/);
  assert.match(text, /OCF\/net income 2023 1\.10x → 2024 1\.20x → 2025 1\.50x/);
  assert.match(text, /not a full accounting-quality test/);
  assert.match(text, /cash less those debts \$50/);
  assert.match(text, /current assets\/liabilities \$800 \/ \$400; working capital \$400; current ratio 2\.00x/);
  assert.match(text, /not standalone solvency conclusions/);
  assert.match(text, /period-end common shares 500\.0M; weighted-average diluted shares 520\.0M \(\+4\.0% vs prior annual period\)/);
  assert.match(text, /weighted-average diluted shares 2023 490\.0M → 2024 500\.0M → 2025 520\.0M/);
  assert.match(text, /diluted EPS \$2\.40/);
  assert.match(text, /diluted EPS 2023 \$1\.80 → 2024 \$2\.00 → 2025 \$2\.40/);
  assert.match(text, /diluted EPS \+15\.5%\/yr \(2023–2025, 3 annual periods\)/);
  assert.match(text, /do not by themselves measure issuance, basic-share dilution, or per-share value creation/);
  assert.match(text, /Available annual trend \(oldest → newest\): revenue 2023 \$900 → 2024 \$1,000 → 2025 \$1,100/);
  assert.match(text, /gross profit 2023 \$540 → 2024 \$600 → 2025 \$660/);
  assert.match(text, /Annualized growth across available SEC periods: revenue \+10\.5%\/yr \(2023–2025, 3 annual periods\)/);
  assert.match(text, /FCF \+16\.2%\/yr \(2023–2025, 3 annual periods\)/);
  assert.match(text, /SEC reported facts only/);
  assert.match(text, /SEC filing/);
});

test('missing SEC facts render unavailable instead of fabricated zero values', () => {
  const text = investmentResearchText({ rows: [{ symbol: 'GAP', decision: 'WATCH_ONLY', horizon: 20, score: null, asOf: '2026-09-23',
    relativeReturns: {}, absoluteReturns: {}, historical: null, reasons: ['insufficient facts'], eventRiskNotes: [],
    annualFundamentals: { status: 'partial', filing: { form: '10-K', filedAt: '2026-02-15', periodEnd: '2025-12-31' },
      metrics: { revenue: { value: null, unit: 'USD' }, netIncome: { value: null, unit: 'USD' },
        longTermDebtCurrent: { value: null, unit: 'USD' }, longTermDebtNoncurrent: { value: null, unit: 'USD' },
        operatingCashConversion: { value: null, unit: 'x' },
        currentAssets: { value: null, unit: 'USD' }, currentLiabilities: { value: null, unit: 'USD' },
        workingCapital: { value: null, unit: 'USD' }, currentRatio: { value: null, unit: 'x' },
        sharesOutstanding: { value: null, unit: 'shares' } } } }], errors: [] });
  assert.match(text, /revenue unavailable/);
  assert.match(text, /debt unavailable \/ unavailable/);
  assert.match(text, /current assets\/liabilities unavailable \/ unavailable; working capital unavailable; current ratio unavailable/);
  assert.match(text, /shares unavailable/);
  assert.match(text, /OCF\/net income unavailable/);
  assert.doesNotMatch(text, /revenue \$0|debt \$0|shares 0\.0M/);
});

test('long SEC-enriched research output keeps the core disclaimer within Discord limits', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ symbol: `SYM${i}`, decision: 'RESEARCH_CANDIDATE', horizon: 20,
    score: 70, asOf: '2026-09-23', relativeReturns: { 20: 1 }, absoluteReturns: { 5: 1, 20: 2, 60: 3 },
    trendPersistence: 80, drawdownPct: -4, historical: null, reasons: [], eventRiskNotes: [], annualFundamentals: {
      status: 'partial', filing: { form: '10-K', filedAt: '2026-02-15', periodEnd: '2025-12-31', url: 'https://www.sec.gov/Archives/edgar/data/123/annual.htm' },
      metrics: Object.fromEntries(['revenue', 'netIncome', 'operatingIncome', 'operatingCashFlow', 'capitalExpenditure', 'freeCashFlow', 'cash', 'longTermDebtCurrent', 'longTermDebtNoncurrent']
        .map((key) => [key, { value: 1_000_000_000, unit: 'USD', history: [
          { periodEnd: '2025-12-31', value: 1_000_000_000 }, { periodEnd: '2024-12-31', value: 900_000_000 },
          { periodEnd: '2023-12-31', value: 800_000_000 }
        ] }]))
    } }));
  const text = investmentResearchText({ rows, errors: [] });
  assert.ok(text.length <= 4000);
  assert.match(text, /Details truncated/);
  assert.match(text, /no multi-year thesis, intrinsic\/fair value, personal portfolio review, or buy instruction/i);
});

test('missing daily sessions, stale history and recent splits prevent clean research status', () => {
  const stock = history(0.002), spy = history(0.001);
  const now = new Date(`${stock.at(-1).date}T22:00:00Z`);
  const result = analyzeInvestment('AAPL', stock.filter((_, i) => i !== 500), spy, { now, events: [{ type: 'split', date: stock.at(-2).date }] });
  assert.equal(result.decision, 'WATCH_ONLY');
  assert.ok(result.reasons.some((r) => /Missing daily/.test(r)));
  assert.equal(result.historical, null);
  assert.ok(result.reasons.some((r) => /split/.test(r)));
  assert.equal(analyzeInvestment('AAPL', stock, spy, { now: new Date(now.getTime() + 14 * 86400000) }).decision, 'WATCH_ONLY');
});

test('historical paths do not overlap and use next-open entry with costs', () => {
  const stock = history(0.002), spy = history(0.001);
  const base = historicalDailyEvidence(stock, spy, 20, 0);
  const cost = historicalDailyEvidence(stock, spy, 20, 50);
  assert.ok(base.samples <= Math.floor((stock.length - 200) / 20));
  assert.ok(Math.abs(base.meanNetReturnPct - cost.meanNetReturnPct - 0.5) < 1e-9);
  const changed = stock.map((b, i) => i === 200 ? { ...b, open: b.open * 2 } : b);
  assert.ok(historicalDailyEvidence(changed, spy, 20, 0).meanNetReturnPct < base.meanNetReturnPct);
});

test('fetch pipeline aligns adjusted stock/SPY data without writing state and reports provider errors', async () => {
  const stock = history(0.002), spy = history(0.001);
  const now = new Date(`${stock.at(-1).date}T22:00:00Z`);
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url); const symbol = new URL(url).pathname.split('/').at(-2);
    if (symbol === 'BAD') return { ok: false, status: 429 };
    const payload = alpacaPayload(symbol === 'SPY' ? spy : stock);
    if (symbol !== 'SPY') { payload.bars[symbol] = payload.bars.SPY; delete payload.bars.SPY; }
    return { ok: true, json: async () => payload };
  };
  const providerMetrics = [];
  const report = await fetchInvestmentResearch(['AAPL', 'BAD'], { fetcher, now, providerMetrics,
    alpacaKeys: { keyId: 'test', secretKey: 'test' }, requestGate: null, retrySleep: async () => {} });
  assert.equal(calls.length, 5); // SPY + AAPL + three bounded BAD attempts
  assert.equal(providerMetrics.filter((metric) => metric.symbol === 'BAD').length, 3);
  assert.ok(providerMetrics.every((metric) => metric.provider === 'Alpaca'));
  assert.equal(report.rows[0].decision, 'RESEARCH_CANDIDATE', JSON.stringify({ row: report.rows[0], errors: report.errors }));
  assert.equal(report.errors[0].symbol, 'BAD');
  assert.match(investmentResearchText(report), /no .*buy instruction/i);
});

test('investment Alpaca bars share Retry-After cooldown across concurrent symbols and retry the throttled symbol', async () => {
  const stock = history(0.002), spy = history(0.001);
  const now = new Date(`${stock.at(-1).date}T22:00:00Z`);
  let simulatedTime = now.getTime();
  const waits = [], attempts = [], providerMetrics = [];
  const requestGate = createAlpacaRequestGate({ now: () => simulatedTime, sleep: async (ms) => { waits.push(ms); simulatedTime += ms; } });
  const fetcher = async (url) => {
    const symbol = new URL(url).pathname.split('/').at(-2);
    attempts.push({ symbol, time: simulatedTime });
    if (symbol === 'AAPL' && attempts.filter((row) => row.symbol === 'AAPL').length === 1) {
      return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '2', 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '0' }),
        json: async () => ({}) };
    }
    const payload = alpacaPayload(symbol === 'SPY' ? spy : stock);
    if (symbol !== 'SPY') { payload.bars[symbol] = payload.bars.SPY; delete payload.bars.SPY; }
    return { ok: true, status: 200, headers: new Headers({ 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '150' }), json: async () => payload };
  };
  const report = await fetchInvestmentResearch(['AAPL'], { fetcher, now, providerMetrics, requestGate,
    alpacaKeys: { keyId: 'test-key', secretKey: 'test-secret' }, clock: () => simulatedTime });
  const aapl = attempts.filter((row) => row.symbol === 'AAPL');
  assert.equal(aapl.length, 2);
  assert.ok(aapl[1].time - aapl[0].time >= 2_000);
  assert.ok(waits.includes(2_000));
  assert.deepEqual(providerMetrics.filter((metric) => metric.symbol === 'AAPL').map((metric) => metric.status), [429, 200]);
  assert.equal(providerMetrics.find((metric) => metric.symbol === 'AAPL' && metric.status === 429).rateLimit.remaining, 0);
  assert.equal(report.errors.length, 0);
  assert.equal(report.rows[0].symbol, 'AAPL');
  assert.match(investmentResearchText(report), /Historical-data provider diagnostics: 3 requests \| 1 retries \| 1 failed attempts/);
  assert.match(investmentResearchText(report), /peak reported quota use 100\.0%/);
});

test('investment Alpaca bars fail immediately on permanent authorization errors', async () => {
  let calls = 0;
  const report = await fetchInvestmentResearch(['SPY'], { alpacaKeys: { keyId: 'test', secretKey: 'test' }, requestGate: null,
    retrySleep: async () => {}, fetcher: async () => { calls++; return { ok: false, status: 403, headers: new Headers(), json: async () => ({}) }; } });
  assert.equal(calls, 1);
  assert.equal(report.providerMetrics.length, 1);
  assert.equal(report.providerMetrics[0].status, 403);
  assert.match(report.errors[0].error, /403/);
});

test('Discord command schema includes invest with all holding periods', () => {
  const command = buildCommands()[0];
  const invest = command.options.find((o) => o.name === 'invest');
  assert.deepEqual(invest.options.find((o) => o.name === 'sessions').choices.map((c) => c.value), [5, 20, 60]);
  assert.match(invest.description, /price-trend research versus SPY; not fundamental underwriting/i);
  assert.ok(command.options.every((o) => !o.options || o.options.length <= 25));
});

test('Discord command schema exposes admin catalyst classification fields', () => {
  const command = buildCommands().find((row) => row.name === 'stocks');
  const catalyst = command.options.find((row) => row.name === 'catalyst');
  assert.ok(catalyst);
  assert.deepEqual(catalyst.options.find((row) => row.name === 'action').choices.map((row) => row.value), ['list', 'add', 'clear']);
  for (const field of ['event_type', 'direction', 'expectedness', 'horizon', 'impact', 'source_url', 'starts_at', 'duration_hours'])
    assert.ok(catalyst.options.some((row) => row.name === field), `missing ${field}`);
  assert.ok(command.options.length <= 25);
});

test('SPY itself has a usable benchmark view and missing last session is flagged immediately', async () => {
  const spy = history(0.001); const now = new Date(`${spy.at(-1).date}T22:00:00Z`);
  const report = await fetchInvestmentResearch(['SPY'], { now, alpacaKeys: { keyId: 'test', secretKey: 'test' }, fetcher: async () => ({ ok: true, json: async () => alpacaPayload(spy) }) });
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].decision, 'BENCHMARK_RESEARCH');
  assert.ok(report.rows[0].absoluteReturns[20] > 0);
  assert.match(investmentResearchText(report), /Broad-market baseline/);
  const stale = analyzeInvestment('AAPL', spy.slice(0, -1), spy.slice(0, -1), { now });
  assert.ok(stale.reasons.some((r) => /latest completed market session/.test(r)));
});

test('current cached earnings vetoes a clean daily candidate while stale and absent coverage is labeled', () => {
  const stock = history(0.002), spy = history(0.001); const now = new Date(`${stock.at(-1).date}T22:00:00Z`);
  const eventContext = { fetchedAt: now.toISOString(), asset: { nextEarningsDate: '2026-04-21', daysToEarnings: 1, earningsChecked: true } };
  const result = analyzeInvestment('AAPL', stock, spy, { now, eventContext });
  assert.equal(result.decision, 'WATCH_ONLY');
  assert.ok(result.reasons.some((r) => /earnings/.test(r)));
  assert.ok(result.eventRiskNotes.some((r) => /current/.test(r)));
  const stale = analyzeInvestment('AAPL', stock, spy, { now, eventContext: { ...eventContext, fetchedAt: new Date(now - 7200000).toISOString() } });
  assert.ok(stale.eventRiskNotes.some((r) => /stale/.test(r)));
  assert.ok(!stale.reasons.some((r) => /Known upcoming earnings/.test(r)));
  assert.ok(analyzeInvestment('AAPL', stock, spy, { now }).eventRiskNotes.some((r) => /unavailable/.test(r)));
});
