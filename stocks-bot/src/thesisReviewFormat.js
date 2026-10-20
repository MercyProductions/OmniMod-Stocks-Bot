const ANNUAL_TREND_LABELS = Object.freeze({
  revenue: 'Revenue',
  netIncome: 'Net income',
  interestExpense: 'Reported interest expense',
  interestCoverageRatio: 'Simplified operating income / interest expense',
  debtMaturityNext12Months: 'Reported principal due in next 12 months at filing date',
  debtMaturityYearTwo: 'Reported principal due in year 2 at filing date',
  debtMaturityYearThree: 'Reported principal due in year 3 at filing date',
  debtMaturityYearFour: 'Reported principal due in year 4 at filing date',
  debtMaturityYearFive: 'Reported principal due in year 5 at filing date',
  debtMaturityAfterYearFive: 'Reported principal due after year 5 at filing date',
  dilutedEps: 'Diluted EPS',
  freeCashFlow: 'Calculated free cash flow',
  cashDividendsPerShare: 'Cash dividends paid per common share',
  cashDividendsPaid: 'Reported cash dividends paid',
  commonStockRepurchases: 'Reported common-stock repurchases',
  weightedAverageDilutedShares: 'Weighted-average diluted shares',
  revenuePerDilutedShare: 'Calculated revenue per diluted share',
  freeCashFlowPerDilutedShare: 'Calculated free cash flow per diluted share'
});

export function annualHistoryFacts(fundamentals = {}) {
  const metrics = fundamentals.metrics || {};
  const reported = ['revenue', 'netIncome', 'interestExpense', 'interestCoverageRatio', 'dilutedEps', 'freeCashFlow', 'cashDividendsPerShare', 'cashDividendsPaid', 'commonStockRepurchases', 'weightedAverageDilutedShares']
    .flatMap((key) => (metrics[key]?.history || []).slice(0, 5).flatMap((row) => {
      const label = ANNUAL_TREND_LABELS[key];
      const period = String(row.periodEnd || '').replaceAll('-', '');
      if (!/^\d{8}$/.test(period) || row.value === null || row.value === undefined || row.value === '' || !Number.isFinite(Number(row.value))) return [];
      const interestRatioSource = key === 'interestCoverageRatio'
        ? `Calculated from SEC operating income ${metrics.operatingIncome?.tag || '(unavailable)'} and interest expense ${metrics.interestExpense?.tag || '(unavailable)'}.` : null;
      return [{ key: `annual_history_${key}_${period}`, label: `${label} annual history`, value: Number(row.value),
        unit: key === 'weightedAverageDilutedShares' ? 'shares' : ['dilutedEps', 'cashDividendsPerShare'].includes(key) ? 'USD/shares' : key === 'interestCoverageRatio' ? 'x' : 'USD',
        periodStart: row.periodStart || '', periodEnd: row.periodEnd,
        factSource: interestRatioSource || (metrics[key]?.tag ? `SEC ${metrics[key].tag} from the selected annual filing accession.` : 'SEC companyfacts from the selected annual filing accession.') }];
    }));
  const byPeriod = (rows = []) => new Map(rows.filter((row) => row.periodStart && row.periodEnd && row.value !== null
    && row.value !== undefined && row.value !== '' && Number.isFinite(Number(row.value)))
    .map((row) => [`${row.periodStart}|${row.periodEnd}`, row]));
  const shares = byPeriod(metrics.weightedAverageDilutedShares?.history || []);
  const derived = [
    ['revenue', 'revenuePerDilutedShare', 'Calculated revenue per diluted share'],
    ['freeCashFlow', 'freeCashFlowPerDilutedShare', 'Calculated free cash flow per diluted share']
  ].flatMap(([numeratorKey, key, label]) => {
    const amounts = byPeriod(metrics[numeratorKey]?.history || []);
    return [...amounts.entries()].flatMap(([periodKey, amount]) => {
      const denominator = shares.get(periodKey);
      if (!denominator || Number(denominator.value) <= 0) return [];
      const periodEnd = denominator.periodEnd;
      const period = periodEnd.replaceAll('-', '');
      return [{ key: `annual_history_${key}_${period}`, label: `${label} annual history`,
        value: Number(amount.value) / Number(denominator.value), unit: 'USD/shares',
        periodStart: denominator.periodStart, periodEnd,
        factSource: `Calculated from SEC ${numeratorKey} and weighted-average diluted shares with exact matching annual period ${periodKey}.` }];
    });
  });
  const maturityBuckets = ['debtMaturityNext12Months', 'debtMaturityYearTwo', 'debtMaturityYearThree', 'debtMaturityYearFour', 'debtMaturityYearFive', 'debtMaturityAfterYearFive']
    .flatMap((key) => {
      const metric = metrics[key] || {};
      const periodEnd = String(metric.periodEnd || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd) || metric.value === null || metric.value === undefined || !Number.isFinite(Number(metric.value))) return [];
      return [{ key: `annual_history_${key}_${periodEnd.replaceAll('-', '')}`, label: ANNUAL_TREND_LABELS[key],
        value: Number(metric.value), unit: 'USD', periodEnd,
        factSource: metric.tag ? `SEC ${metric.tag} from the selected annual filing accession.` : 'SEC companyfacts from the selected annual filing accession.' }];
    });
  return [...reported, ...derived, ...maturityBuckets];
}

function formatFactValue(fact) {
  if (fact.value === null || fact.value === undefined || fact.value === '' || !Number.isFinite(Number(fact.value))) return 'unavailable';
  if (fact.unit === 'shares') return `${(Number(fact.value) / 1e6).toFixed(1)}M shares`;
  if (fact.unit === 'USD' || fact.unit === 'USD/shares') return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD',
    maximumFractionDigits: fact.unit === 'USD/shares' ? 2 : 0 }).format(Number(fact.value));
  if (fact.unit === 'x') return `${Number(fact.value).toFixed(2)}x`;
  return Number(fact.value).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function formatAnnualHistory(facts = []) {
  return Object.entries(ANNUAL_TREND_LABELS).map(([key, label]) => {
    const rows = facts.filter((fact) => fact.key.startsWith(`annual_history_${key}_`))
      .sort((a, b) => String(a.periodEnd).localeCompare(String(b.periodEnd)));
    return rows.length ? `${label}: ${rows.map((fact) => `${fact.periodEnd} ${formatFactValue(fact)}`).join(' → ')}` : '';
  }).filter(Boolean).join('\n');
}

export function latestAnnualTrendFacts(facts = []) {
  return ['revenue', 'netIncome', 'interestExpense', 'interestCoverageRatio', 'debtMaturityNext12Months', 'debtMaturityYearTwo', 'debtMaturityYearThree', 'debtMaturityYearFour', 'debtMaturityYearFive', 'debtMaturityAfterYearFive', 'dilutedEps', 'freeCashFlow', 'cashDividendsPerShare', 'cashDividendsPaid', 'commonStockRepurchases', 'weightedAverageDilutedShares', 'revenuePerDilutedShare', 'freeCashFlowPerDilutedShare'].flatMap((key) =>
    facts.filter((fact) => fact.key.startsWith(`annual_history_${key}_`))
      .sort((a, b) => String(b.periodEnd).localeCompare(String(a.periodEnd))).slice(0, 1));
}
