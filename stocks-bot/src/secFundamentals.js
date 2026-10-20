const ANNUAL_FORMS = new Set(['10-K', '20-F', '40-F']);
const DURATIONS = Object.freeze({
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'],
  grossProfit: ['GrossProfit'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  operatingIncome: ['OperatingIncomeLoss'],
  interestExpense: ['InterestExpenseNonOperating', 'InterestAndDebtExpense'],
  operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities', 'CashFlowsFromUsedInOperatingActivities'],
  capitalExpenditure: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
  cashDividendsPerShare: ['CommonStockDividendsPerShareCashPaid'],
  cashDividendsPaid: ['PaymentsOfDividendsCommonStock'],
  commonStockRepurchases: ['PaymentsForRepurchaseOfCommonStock'],
  weightedAverageDilutedShares: ['WeightedAverageNumberOfDilutedSharesOutstanding'],
  dilutedEps: ['EarningsPerShareDiluted']
});
const INSTANTS = Object.freeze({
  totalAssets: ['Assets'],
  stockholdersEquity: ['StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest', 'StockholdersEquity'],
  currentAssets: ['AssetsCurrent', 'CurrentAssets'],
  currentLiabilities: ['LiabilitiesCurrent', 'CurrentLiabilities'],
  accountsReceivable: ['AccountsReceivableNetCurrent'],
  inventory: ['InventoryNet'],
  cash: ['CashAndCashEquivalentsAtCarryingValue'],
  longTermDebtCurrent: ['LongTermDebtCurrent', 'LongTermDebtAndFinanceLeaseObligationsCurrent'],
  longTermDebtNoncurrent: ['LongTermDebtNoncurrent', 'LongTermDebtAndFinanceLeaseObligationsNoncurrent'],
  debtMaturityNext12Months: ['LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths'],
  debtMaturityYearTwo: ['LongTermDebtMaturitiesRepaymentsOfPrincipalInYearTwo'],
  debtMaturityYearThree: ['LongTermDebtMaturitiesRepaymentsOfPrincipalInYearThree'],
  debtMaturityYearFour: ['LongTermDebtMaturitiesRepaymentsOfPrincipalInYearFour'],
  debtMaturityYearFive: ['LongTermDebtMaturitiesRepaymentsOfPrincipalInYearFive'],
  debtMaturityAfterYearFive: ['LongTermDebtMaturitiesRepaymentsOfPrincipalAfterYearFive'],
  sharesOutstanding: ['EntityCommonStockSharesOutstanding', 'CommonStockSharesOutstanding']
});

function iso(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : '';
}

function accession(value) { return String(value || '').replaceAll('-', ''); }

function durationUnit(key) {
  if (key === 'weightedAverageDilutedShares') return 'shares';
  if (key === 'dilutedEps' || key === 'cashDividendsPerShare') return 'USD/shares';
  return 'USD';
}

function annualFilings(submissions, now) {
  const recent = submissions?.filings?.recent || {};
  const rows = Array.from({ length: recent.form?.length || 0 }, (_, index) => ({
    form: String(recent.form?.[index] || ''),
    filedAt: iso(recent.filingDate?.[index]),
    reportDate: iso(recent.reportDate?.[index]),
    accessionNumber: String(recent.accessionNumber?.[index] || ''),
    primaryDocument: String(recent.primaryDocument?.[index] || '')
  })).filter((row) => ANNUAL_FORMS.has(row.form) && row.reportDate && row.filedAt
    && Date.parse(`${row.filedAt}T23:59:59Z`) <= now.getTime())
    .sort((left, right) => right.filedAt.localeCompare(left.filedAt));
  const seenPeriods = new Set();
  return rows.filter((row) => {
    if (seenPeriods.has(row.reportDate)) return false;
    seenPeriods.add(row.reportDate);
    return true;
  });
}

function latestAnnualFiling(submissions, now) {
  return annualFilings(submissions, now)[0] || null;
}

function latestQuarterFiling(submissions, now) {
  const recent = submissions?.filings?.recent || {};
  return Array.from({ length: recent.form?.length || 0 }, (_, index) => ({
    form: String(recent.form?.[index] || ''), filedAt: iso(recent.filingDate?.[index]),
    reportDate: iso(recent.reportDate?.[index]), accessionNumber: String(recent.accessionNumber?.[index] || ''),
    primaryDocument: String(recent.primaryDocument?.[index] || '')
  })).filter((row) => row.form === '10-Q' && row.reportDate && row.filedAt
    && Date.parse(`${row.filedAt}T23:59:59Z`) <= now.getTime())
    .sort((left, right) => right.filedAt.localeCompare(left.filedAt))[0] || null;
}

function quarterDurationMetric(companyFacts, tags, filing, key, unit, now) {
  const accessionNumber = accession(filing.accessionNumber);
  const candidates = [];
  for (const taxonomy of ['us-gaap', 'ifrs-full']) {
    const source = companyFacts?.facts?.[taxonomy] || {};
    for (const tag of tags) {
      const fact = source[tag];
      if (!fact) continue;
      const rows = fact.units?.[unit] || [];
      const current = rows.filter((row) => accession(row.accn) === accessionNumber && row.form === '10-Q'
        && (!row.filed || Date.parse(`${iso(row.filed)}T23:59:59Z`) <= now.getTime())
        && iso(row.end) === filing.reportDate && iso(row.start) && Number.isFinite(Number(row.val)))
        .map((row) => ({ row, days: (Date.parse(`${iso(row.end)}T00:00:00Z`) - Date.parse(`${iso(row.start)}T00:00:00Z`)) / 86_400_000 + 1 }))
        .filter(({ days }) => days >= 65 && days <= 115)
        .sort((a, b) => Math.abs(a.days - 91) - Math.abs(b.days - 91));
      if (!current.length) continue;
      const selected = current[0];
      const prior = rows.filter((row) => accession(row.accn) === accessionNumber && row.form === '10-Q'
        && (!row.filed || Date.parse(`${iso(row.filed)}T23:59:59Z`) <= now.getTime()) && iso(row.start) && iso(row.end) < filing.reportDate
        && Number.isFinite(Number(row.val)) && (!selected.row.fp || !row.fp || row.fp === selected.row.fp))
        .map((row) => ({ row, days: (Date.parse(`${iso(row.end)}T00:00:00Z`) - Date.parse(`${iso(row.start)}T00:00:00Z`)) / 86_400_000 + 1,
          gap: (Date.parse(`${filing.reportDate}T00:00:00Z`) - Date.parse(`${iso(row.end)}T00:00:00Z`)) / 86_400_000 }))
        .filter(({ days, gap }) => days >= 65 && days <= 115 && gap >= 330 && gap <= 400)
        .sort((a, b) => Math.abs(a.gap - 365) - Math.abs(b.gap - 365))[0]?.row;
      candidates.push({ key, tag, unit, value: Number(selected.row.val), periodStart: iso(selected.row.start), periodEnd: filing.reportDate,
        priorValue: prior ? Number(prior.val) : null, priorPeriodEnd: prior ? iso(prior.end) : '',
        growthPct: prior && Number(prior.val) > 0 && Number(selected.row.val) >= 0 ? (Number(selected.row.val) / Number(prior.val) - 1) * 100 : null,
        durationDays: selected.days });
      break;
    }
    if (candidates.length) break;
  }
  return candidates[0] || { key, value: null, priorValue: null, growthPct: null, periodStart: '', periodEnd: filing.reportDate, priorPeriodEnd: '', tag: '', unit, durationDays: null };
}

function quarterInstantMetric(companyFacts, tags, filing, key, unit, now) {
  const accessionNumber = accession(filing.accessionNumber);
  for (const taxonomy of ['us-gaap', 'ifrs-full', 'dei']) {
    const source = companyFacts?.facts?.[taxonomy] || {};
    for (const tag of tags) {
      const rows = (source[tag]?.units?.[unit] || []).filter((row) => accession(row.accn) === accessionNumber
        && row.form === '10-Q' && !row.start && iso(row.end) === filing.reportDate
        && (!row.filed || Date.parse(`${iso(row.filed)}T23:59:59Z`) <= now.getTime()) && Number.isFinite(Number(row.val)));
      if (rows.length) return { key, value: Number(rows.at(-1).val), periodEnd: filing.reportDate, tag, unit };
    }
  }
  return { key, value: null, periodEnd: filing.reportDate, tag: '', unit };
}

function latestQuarterFacts(companyFacts, filing, now, cik) {
  if (!filing) return { status: 'unavailable', reason: 'No filed 10-Q is available for quarterly comparison.', filing: null, metrics: {} };
  const durations = Object.fromEntries(Object.entries(DURATIONS).map(([key, tags]) => [key,
    quarterDurationMetric(companyFacts, tags, filing, key, durationUnit(key), now)]));
  const instants = Object.fromEntries(Object.entries(INSTANTS).map(([key, tags]) => [key,
    quarterInstantMetric(companyFacts, tags, filing, key, key === 'sharesOutstanding' ? 'shares' : 'USD', now)]));
  const metrics = { ...durations, ...instants };
  const operatingIncome = metrics.operatingIncome, interestExpense = metrics.interestExpense;
  const alignedInterest = operatingIncome?.tag && interestExpense?.tag && operatingIncome.unit === 'USD' && interestExpense.unit === 'USD'
    && operatingIncome.periodStart === interestExpense.periodStart && operatingIncome.periodEnd === interestExpense.periodEnd
    && Number.isFinite(operatingIncome.value) && Number.isFinite(interestExpense.value) && Math.abs(interestExpense.value) > 0;
  metrics.interestCoverageRatio = { key: 'interestCoverageRatio',
    value: alignedInterest ? operatingIncome.value / Math.abs(interestExpense.value) : null,
    periodStart: alignedInterest ? operatingIncome.periodStart : '', periodEnd: filing.reportDate, unit: 'x',
    method: 'Simplified operating income divided by absolute reported interest expense, only when standardized USD facts have identical quarter dates. Not appropriate as a stand-alone credit measure and not sector-adjusted.' };
  const samePeriod = (a, b) => a?.periodStart && a.periodStart === b?.periodStart && a.periodEnd === b?.periodEnd && Number.isFinite(a.value) && Number.isFinite(b?.value);
  const cashFlow = metrics.operatingCashFlow, capex = metrics.capitalExpenditure, revenue = metrics.revenue;
  metrics.freeCashFlow = { key: 'freeCashFlow', value: samePeriod(cashFlow, capex) ? cashFlow.value - Math.abs(capex.value) : null,
    periodStart: samePeriod(cashFlow, capex) ? cashFlow.periodStart : '', periodEnd: filing.reportDate, unit: 'USD' };
  for (const [key, numerator] of [['grossMarginPct', metrics.grossProfit], ['operatingMarginPct', metrics.operatingIncome], ['netMarginPct', metrics.netIncome], ['freeCashFlowMarginPct', metrics.freeCashFlow]]) {
    metrics[key] = { key, value: samePeriod(numerator, revenue) && revenue.value !== 0 ? numerator.value / revenue.value * 100 : null,
      periodStart: samePeriod(numerator, revenue) ? revenue.periodStart : '', periodEnd: filing.reportDate, unit: 'percent' };
  }
  const assets = metrics.currentAssets, liabilities = metrics.currentLiabilities;
  const alignedBalance = Number.isFinite(assets.value) && Number.isFinite(liabilities.value) && assets.periodEnd === liabilities.periodEnd;
  metrics.workingCapital = { key: 'workingCapital', value: alignedBalance ? assets.value - liabilities.value : null, periodEnd: filing.reportDate, unit: 'USD' };
  metrics.currentRatio = { key: 'currentRatio', value: alignedBalance && liabilities.value > 0 ? assets.value / liabilities.value : null, periodEnd: filing.reportDate, unit: 'x' };
  const debt = [metrics.longTermDebtCurrent, metrics.longTermDebtNoncurrent, metrics.cash];
  metrics.cashLessLongTermDebt = { key: 'cashLessLongTermDebt', value: debt.every((item) => Number.isFinite(item.value) && item.periodEnd === filing.reportDate)
    ? debt[2].value - debt[0].value - debt[1].value : null, periodEnd: filing.reportDate, unit: 'USD' };
  const valid = Object.values(metrics).some((row) => Number.isFinite(row.value));
  const accessionPath = accession(filing.accessionNumber);
  return { status: valid ? 'partial' : 'coverage_limited',
    filing: { form: filing.form, filedAt: filing.filedAt, periodEnd: filing.reportDate, accession: filing.accessionNumber,
      url: filing.primaryDocument ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionPath}/${filing.primaryDocument}` : `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionPath}/` },
    metrics, note: 'Quarterly duration facts are accepted only for the 10-Q accession, an approximately three-month interval and its exact reported quarter-end. Cash-flow facts not reported as discrete-quarter values remain unavailable.' };
}

function taxonomyFacts(companyFacts, tags) {
  for (const taxonomy of ['us-gaap', 'ifrs-full', 'dei']) {
    const facts = companyFacts?.facts?.[taxonomy] || {};
    for (const tag of tags) if (facts[tag]) return { tag, fact: facts[tag] };
  }
  return null;
}

function filingRows(companyFacts, tags, filing, { duration = false, unit = 'USD' } = {}) {
  const matched = taxonomyFacts(companyFacts, tags);
  if (!matched) return { tag: '', values: [] };
  const filtered = (matched.fact.units?.[unit] || []).filter((row) => {
    if (accession(row.accn) !== accession(filing.accessionNumber) || !Number.isFinite(Number(row.val))) return false;
    const end = iso(row.end);
    if (!end || end > filing.reportDate) return false;
    if (!duration) return end === filing.reportDate;
    const start = iso(row.start);
    if (!start) return false;
    const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 + 1;
    return days >= 330 && days <= 400;
  });
  const byEnd = new Map();
  for (const row of filtered) {
    const current = byEnd.get(row.end);
    const duration = row.start ? (Date.parse(`${row.end}T00:00:00Z`) - Date.parse(`${row.start}T00:00:00Z`)) / 86_400_000 + 1 : Infinity;
    const currentDuration = current?.start ? (Date.parse(`${current.end}T00:00:00Z`) - Date.parse(`${current.start}T00:00:00Z`)) / 86_400_000 + 1 : Infinity;
    const rank = (candidate, candidateDuration) => (candidate.fp === 'FY' ? 0 : 1) * 1000 + Math.abs(candidateDuration - 365);
    if (!current || rank(row, duration) < rank(current, currentDuration)) byEnd.set(row.end, row);
  }
  const values = [...byEnd.values()].sort((left, right) => String(right.end).localeCompare(String(left.end)));
  return { tag: matched.tag, values };
}

function annualMetric(companyFacts, tags, filing, key, unit = 'USD') {
  const { tag, values } = filingRows(companyFacts, tags, filing, { duration: true, unit });
  const latest = values[0];
  if (!latest) return { key, value: null, priorValue: null, growthPct: null, periodEnd: filing.reportDate, tag: tag || '', unit, history: [] };
  const latestDuration = (Date.parse(`${latest.end}T00:00:00Z`) - Date.parse(`${latest.start}T00:00:00Z`)) / 86_400_000 + 1;
  const prior = values.slice(1).find((row) => {
    const days = (Date.parse(`${latest.end}T00:00:00Z`) - Date.parse(`${row.end}T00:00:00Z`)) / 86_400_000;
    const duration = (Date.parse(`${row.end}T00:00:00Z`) - Date.parse(`${row.start}T00:00:00Z`)) / 86_400_000 + 1;
    return days >= 330 && days <= 400 && Math.abs(duration - latestDuration) <= 30;
  });
  const value = Number(latest.val);
  const priorValue = prior ? Number(prior.val) : null;
  return { key, value, priorValue, growthPct: priorValue > 0 && value >= 0 ? (value / priorValue - 1) * 100 : null,
    periodStart: latest.start, periodEnd: latest.end, priorPeriodEnd: prior?.end || '', tag, unit,
    history: values.slice(0, 5).map((row) => ({ periodStart: row.start, periodEnd: row.end, value: Number(row.val) })) };
}

function instantMetric(companyFacts, tags, filing, key, unit) {
  const { tag, values } = filingRows(companyFacts, tags, filing, { unit });
  const latest = values[0];
  return { key, value: latest ? Number(latest.val) : null, periodEnd: filing.reportDate, tag: tag || '', unit };
}

function historicalAnnualValuationInputs(companyFacts, submissions, now) {
  return annualFilings(submissions, now).filter((filing) => filing.form === '10-K').slice(0, 6).map((filing) => {
    const revenue = annualMetric(companyFacts, DURATIONS.revenue, filing, 'revenue');
    const netIncome = annualMetric(companyFacts, DURATIONS.netIncome, filing, 'netIncome');
    const operatingCashFlow = annualMetric(companyFacts, DURATIONS.operatingCashFlow, filing, 'operatingCashFlow');
    const capitalExpenditure = annualMetric(companyFacts, DURATIONS.capitalExpenditure, filing, 'capitalExpenditure');
    const sharesOutstanding = instantMetric(companyFacts, INSTANTS.sharesOutstanding, filing, 'sharesOutstanding', 'shares');
    const alignedCashFlows = operatingCashFlow.tag && capitalExpenditure.tag
      && operatingCashFlow.periodStart === capitalExpenditure.periodStart
      && operatingCashFlow.periodEnd === capitalExpenditure.periodEnd;
    return {
      filing: { form: filing.form, filedAt: filing.filedAt, periodEnd: filing.reportDate, accession: filing.accessionNumber },
      revenue: { value: revenue.value, unit: revenue.unit, periodEnd: revenue.periodEnd },
      netIncome: { value: netIncome.value, unit: netIncome.unit, periodEnd: netIncome.periodEnd },
      freeCashFlow: { value: alignedCashFlows ? operatingCashFlow.value - Math.abs(capitalExpenditure.value) : null,
        unit: 'USD', periodEnd: alignedCashFlows ? operatingCashFlow.periodEnd : '' },
      sharesOutstanding: { value: sharesOutstanding.value, unit: sharesOutstanding.unit, periodEnd: sharesOutstanding.periodEnd }
    };
  });
}

function instantAnnualHistoryMetric(companyFacts, tags, filing, key, unit) {
  const matched = taxonomyFacts(companyFacts, tags);
  if (!matched) return { key, value: null, priorValue: null, growthPct: null, periodEnd: filing.reportDate, tag: '', unit, history: [] };
  const values = (matched.fact.units?.[unit] || []).filter((row) => accession(row.accn) === accession(filing.accessionNumber)
    && !row.start && iso(row.end) && iso(row.end) <= filing.reportDate && Number.isFinite(Number(row.val)))
    .sort((a, b) => String(b.end).localeCompare(String(a.end)));
  const byEnd = new Map();
  for (const row of values) if (!byEnd.has(iso(row.end))) byEnd.set(iso(row.end), row);
  const history = [...byEnd.entries()].slice(0, 5).map(([periodEnd, row]) => ({ periodEnd, value: Number(row.val) }));
  const latest = history.find((row) => row.periodEnd === filing.reportDate) || null;
  const prior = latest && history.find((row) => {
    const days = (Date.parse(`${latest.periodEnd}T00:00:00Z`) - Date.parse(`${row.periodEnd}T00:00:00Z`)) / 86_400_000;
    return days >= 330 && days <= 400;
  });
  return { key, value: latest?.value ?? null, priorValue: prior?.value ?? null, priorPeriodEnd: prior?.periodEnd || '',
    growthPct: prior?.value > 0 && latest.value >= 0 ? (latest.value / prior.value - 1) * 100 : null,
    periodEnd: latest?.periodEnd || filing.reportDate, tag: matched.tag, unit, history };
}

function returnOnAverageBalanceMetric(income, balance, key) {
  const balanceByEnd = new Map((balance.history || []).map((row) => [row.periodEnd, row.value]));
  const balanceHistory = balance.history || [];
  const history = (income.history || []).flatMap((period) => {
    const endingBalance = balanceByEnd.get(period.periodEnd);
    const priorBalance = balanceHistory.filter((row) => {
      const days = (Date.parse(`${period.periodEnd}T00:00:00Z`) - Date.parse(`${row.periodEnd}T00:00:00Z`)) / 86_400_000;
      return days >= 330 && days <= 400;
    }).sort((a, b) => Math.abs((Date.parse(`${period.periodEnd}T00:00:00Z`) - Date.parse(`${a.periodEnd}T00:00:00Z`)) / 86_400_000 - 365)
      - Math.abs((Date.parse(`${period.periodEnd}T00:00:00Z`) - Date.parse(`${b.periodEnd}T00:00:00Z`)) / 86_400_000 - 365))[0]?.value;
    const average = (endingBalance + priorBalance) / 2;
    return Number.isFinite(period.value) && Number.isFinite(endingBalance) && Number.isFinite(priorBalance) && average > 0
      ? [{ periodStart: period.periodStart, periodEnd: period.periodEnd, value: period.value / average * 100 }] : [];
  });
  return { key, value: history[0]?.value ?? null, periodStart: history[0]?.periodStart || '',
    periodEnd: history[0]?.periodEnd || income.periodEnd || '', unit: 'percent', history,
    method: `Reported annual net income divided by the average of reported ${key === 'returnOnEquityPct' ? 'total stockholders’ equity' : 'total assets'} at the fiscal year-end and preceding fiscal year-end. Both balance periods must be present in the same annual filing accession; the average balance must be positive. Descriptive historical ratio, not a forecast or quality verdict.` };
}

export function normalizeSecAnnualFundamentals(symbol, cik, submissions, companyFacts, now = new Date()) {
  const filing = latestAnnualFiling(submissions, now);
  if (!filing) return { symbol, status: 'unavailable', reason: 'No recent 10-K, 20-F, or 40-F filing with a report period was found.' };
  const quarterly = latestQuarterFacts(companyFacts, latestQuarterFiling(submissions, now), now, cik);
  const metrics = Object.fromEntries(Object.entries(DURATIONS).map(([key, tags]) => [key,
    annualMetric(companyFacts, tags, filing, key, durationUnit(key))]));
  for (const [key, tags] of Object.entries(INSTANTS)) {
    const unit = key === 'sharesOutstanding' ? 'shares' : 'USD';
    metrics[key] = ['totalAssets', 'stockholdersEquity', 'accountsReceivable', 'inventory'].includes(key)
      ? instantAnnualHistoryMetric(companyFacts, tags, filing, key, unit)
      : instantMetric(companyFacts, tags, filing, key, unit);
  }
  const receivables = metrics.accountsReceivable, revenue = metrics.revenue;
  const sameAnnualPeriods = Boolean(receivables.periodEnd && receivables.periodEnd === revenue.periodEnd && receivables.priorPeriodEnd);
  const priorRevenue = revenue.history.find((row) => row.periodEnd === revenue.priorPeriodEnd);
  const priorDatesAlign = priorRevenue && Math.abs(Date.parse(`${priorRevenue.periodEnd}T00:00:00Z`) - Date.parse(`${receivables.priorPeriodEnd}T00:00:00Z`)) <= 7 * 86_400_000;
  metrics.receivablesRevenueGrowthGapPp = { key: 'receivablesRevenueGrowthGapPp',
    value: sameAnnualPeriods && priorDatesAlign && revenue.value > 0 && revenue.priorValue > 0
      && receivables.priorValue > 0 && Number.isFinite(receivables.growthPct) && Number.isFinite(revenue.growthPct)
      ? receivables.growthPct - revenue.growthPct : null,
    periodEnd: sameAnnualPeriods && priorDatesAlign ? receivables.periodEnd : filing.reportDate, unit: 'percentage_points',
    method: 'Reported net current receivables growth minus reported annual revenue growth, only when current and prior period ends align within seven days; descriptive working-capital context, not an accounting-quality verdict.' };
  const opCash = metrics.operatingCashFlow.value;
  const capex = metrics.capitalExpenditure.value;
  const freeCashFlowAligned = Boolean(metrics.operatingCashFlow.tag && metrics.capitalExpenditure.tag
    && metrics.operatingCashFlow.periodStart === metrics.capitalExpenditure.periodStart
    && metrics.operatingCashFlow.periodEnd === metrics.capitalExpenditure.periodEnd
    && Number.isFinite(opCash) && Number.isFinite(capex));
  const freeCashFlowHistory = metrics.operatingCashFlow.history.flatMap((row) => {
    const capexForPeriod = metrics.capitalExpenditure.history.find((item) => item.periodStart === row.periodStart && item.periodEnd === row.periodEnd);
    return capexForPeriod ? [{ periodStart: row.periodStart, periodEnd: row.periodEnd, value: row.value - Math.abs(capexForPeriod.value) }] : [];
  });
  metrics.freeCashFlow = {
    key: 'freeCashFlow', value: freeCashFlowAligned ? opCash - Math.abs(capex) : null,
    periodEnd: freeCashFlowAligned ? metrics.operatingCashFlow.periodEnd : filing.reportDate, unit: 'USD', sourceAligned: freeCashFlowAligned,
    history: freeCashFlowHistory,
    method: 'Reported operating cash flow minus absolute reported capital expenditure; current FCF requires standardized USD facts with identical period start and end dates. Historical FCF is calculated only for exact start/end-date intersections.'
  };
  const operatingIncome = metrics.operatingIncome, interestExpense = metrics.interestExpense;
  const alignedInterest = operatingIncome?.tag && interestExpense?.tag && operatingIncome.unit === 'USD' && interestExpense.unit === 'USD'
    && operatingIncome.periodStart === interestExpense.periodStart && operatingIncome.periodEnd === interestExpense.periodEnd
    && Number.isFinite(operatingIncome.value) && Number.isFinite(interestExpense.value) && Math.abs(interestExpense.value) > 0;
  const interestExpenseByPeriod = new Map((interestExpense.history || []).map((row) => [`${row.periodStart}|${row.periodEnd}`, row.value]));
  metrics.interestCoverageRatio = { key: 'interestCoverageRatio',
    value: alignedInterest ? operatingIncome.value / Math.abs(interestExpense.value) : null,
    periodStart: alignedInterest ? operatingIncome.periodStart : '', periodEnd: alignedInterest ? operatingIncome.periodEnd : filing.reportDate, unit: 'x',
    history: (operatingIncome.history || []).flatMap((row) => {
      const expense = interestExpenseByPeriod.get(`${row.periodStart}|${row.periodEnd}`);
      return Number.isFinite(expense) && Math.abs(expense) > 0
        ? [{ periodStart: row.periodStart, periodEnd: row.periodEnd, value: row.value / Math.abs(expense) }] : [];
    }),
    method: 'Simplified operating income divided by absolute reported interest expense, only when standardized USD facts have identical annual dates. Not appropriate as a stand-alone credit measure and not sector-adjusted.' };
  const margin = (key, numerator) => {
    const revenue = metrics.revenue;
    const aligned = (numerator?.tag || numerator?.sourceAligned) && revenue.tag && numerator.unit === 'USD' && revenue.unit === 'USD'
      && numerator.periodEnd === revenue.periodEnd && Number.isFinite(Number(numerator.value))
      && Number.isFinite(Number(revenue.value)) && Number(revenue.value) !== 0;
    return { key, value: aligned ? Number(numerator.value) / Number(revenue.value) * 100 : null,
      periodEnd: aligned ? revenue.periodEnd : filing.reportDate, unit: 'percent',
      method: `Reported ${key === 'operatingMarginPct' ? 'operating income' : key === 'netMarginPct' ? 'net income' : 'calculated free cash flow'} divided by reported revenue; requires both standardized USD facts from the same annual period.` };
  };
  metrics.operatingMarginPct = margin('operatingMarginPct', metrics.operatingIncome);
  metrics.grossMarginPct = margin('grossMarginPct', metrics.grossProfit);
  metrics.netMarginPct = margin('netMarginPct', metrics.netIncome);
  metrics.freeCashFlowMarginPct = margin('freeCashFlowMarginPct', metrics.freeCashFlow);
  const assets = metrics.currentAssets, liabilities = metrics.currentLiabilities;
  const currentBalanceAligned = assets.tag && liabilities.tag && assets.unit === 'USD' && liabilities.unit === 'USD'
    && assets.periodEnd === liabilities.periodEnd && Number.isFinite(assets.value) && Number.isFinite(liabilities.value);
  metrics.workingCapital = { key: 'workingCapital', value: currentBalanceAligned ? assets.value - liabilities.value : null,
    periodEnd: currentBalanceAligned ? assets.periodEnd : filing.reportDate, unit: 'USD',
    method: 'Reported current assets minus reported current liabilities; requires both standardized USD facts from the same annual filing and period end.' };
  metrics.currentRatio = { key: 'currentRatio', value: currentBalanceAligned && liabilities.value > 0 ? assets.value / liabilities.value : null,
    periodEnd: currentBalanceAligned && liabilities.value > 0 ? assets.periodEnd : filing.reportDate, unit: 'x',
    method: 'Reported current assets divided by reported current liabilities; requires positive current liabilities and period-aligned standardized USD facts. This is descriptive and not a standalone solvency conclusion.' };
  const operatingCashFlow = metrics.operatingCashFlow, netIncome = metrics.netIncome;
  const alignedCashEarnings = operatingCashFlow.tag && netIncome.tag && operatingCashFlow.unit === 'USD' && netIncome.unit === 'USD'
    && operatingCashFlow.periodStart === netIncome.periodStart && operatingCashFlow.periodEnd === netIncome.periodEnd
    && Number.isFinite(operatingCashFlow.value) && Number.isFinite(netIncome.value) && netIncome.value > 0;
  const netIncomePeriods = new Map(netIncome.history.filter((row) => row.value > 0).map((row) => [`${row.periodStart}|${row.periodEnd}`, row.value]));
  metrics.operatingCashConversion = { key: 'operatingCashConversion', value: alignedCashEarnings ? operatingCashFlow.value / netIncome.value : null,
    periodStart: alignedCashEarnings ? netIncome.periodStart : '', periodEnd: alignedCashEarnings ? netIncome.periodEnd : filing.reportDate, unit: 'x',
    history: operatingCashFlow.history.flatMap((row) => {
      const income = netIncomePeriods.get(`${row.periodStart}|${row.periodEnd}`);
      return income > 0 && Number.isFinite(row.value) ? [{ periodStart: row.periodStart, periodEnd: row.periodEnd, value: row.value / income }] : [];
    }),
    method: 'Reported operating cash flow divided by reported net income; requires positive net income and matching standardized USD facts from the same annual periods. Working-capital and other timing effects can make this ratio volatile.' };
  metrics.returnOnEquityPct = returnOnAverageBalanceMetric(netIncome, metrics.stockholdersEquity, 'returnOnEquityPct');
  metrics.returnOnAssetsPct = returnOnAverageBalanceMetric(netIncome, metrics.totalAssets, 'returnOnAssetsPct');
  const cash = metrics.cash.value, currentDebt = metrics.longTermDebtCurrent.value, noncurrentDebt = metrics.longTermDebtNoncurrent.value;
  const netCashAvailable = [cash, currentDebt, noncurrentDebt].every(Number.isFinite);
  metrics.cashLessLongTermDebt = { key: 'cashLessLongTermDebt', value: netCashAvailable ? cash - currentDebt - noncurrentDebt : null,
    periodEnd: filing.reportDate, unit: 'USD',
    method: 'Reported cash and equivalents minus reported current and noncurrent long-term debt; not total net debt or a liquidity assessment.' };
  const accessionPath = accession(filing.accessionNumber);
  return {
    symbol, cik: String(cik), status: Object.values(metrics).some((row) => row.value !== null) ? 'partial' : 'coverage_limited',
    filing: { form: filing.form, filedAt: filing.filedAt, periodEnd: filing.reportDate, accession: filing.accessionNumber,
      url: filing.primaryDocument ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionPath}/${filing.primaryDocument}` : `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionPath}/` },
    metrics, quarterly, historicalValuationInputs: historicalAnnualValuationInputs(companyFacts, submissions, now),
    limitations: ['Uses standardized SEC companyfacts only; company-specific/custom XBRL tags are not included.',
      'Annual facts are selected from the latest annual filing accession; metric availability and accounting comparability vary by issuer.',
      'This snapshot does not assess valuation, debt maturities, cash-flow quality, management, moat, taxes, or portfolio suitability.']
  };
}
