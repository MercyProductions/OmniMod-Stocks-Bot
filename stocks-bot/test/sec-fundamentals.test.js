import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSecAnnualFundamentals } from '../src/secFundamentals.js';

const filing = { form: ['10-K'], filingDate: ['2026-02-15'], reportDate: ['2025-12-31'],
  accessionNumber: ['0000123456-26-000001'], primaryDocument: ['annual.htm'] };
const accession = '0000123456-26-000001';

function fact(tag, unit, rows) { return { label: tag, units: { [unit]: rows.map((row) => ({ ...row, accn: row.accn || accession, form: row.form || '10-K', fy: row.fy ?? 2025, fp: row.fp || 'FY' })) } }; }
function companyFacts() {
  const annual = (start, end, val) => ({ start, end, val });
  const instant = (end, val) => ({ end, val });
  return { facts: { 'us-gaap': {
    RevenueFromContractWithCustomerExcludingAssessedTax: fact('Revenue', 'USD', [annual('2025-01-01', '2025-12-31', 1100), annual('2024-01-01', '2024-12-31', 1000), annual('2023-01-01', '2023-12-31', 900)]),
    GrossProfit: fact('GrossProfit', 'USD', [annual('2025-01-01', '2025-12-31', 660)]),
    NetIncomeLoss: fact('NetIncomeLoss', 'USD', [annual('2025-01-01', '2025-12-31', 120), annual('2024-01-01', '2024-12-31', 100), annual('2023-01-01', '2023-12-31', 80)]),
    WeightedAverageNumberOfDilutedSharesOutstanding: fact('DilutedShares', 'shares', [annual('2025-01-01', '2025-12-31', 520_000_000), annual('2024-01-01', '2024-12-31', 500_000_000), annual('2023-01-01', '2023-12-31', 490_000_000)]),
    EarningsPerShareDiluted: fact('DilutedEPS', 'USD/shares', [annual('2025-01-01', '2025-12-31', 2.4), annual('2024-01-01', '2024-12-31', 2.0), annual('2023-01-01', '2023-12-31', 1.8)]),
    CommonStockDividendsPerShareCashPaid: fact('CashDividendsPerShare', 'USD/shares', [annual('2025-01-01', '2025-12-31', 1.12), annual('2024-01-01', '2024-12-31', 1.04), annual('2023-01-01', '2023-12-31', 0.96)]),
    PaymentsOfDividendsCommonStock: fact('CashDividendsPaid', 'USD', [annual('2025-01-01', '2025-12-31', 35), annual('2024-01-01', '2024-12-31', 32), annual('2023-01-01', '2023-12-31', 29)]),
    PaymentsForRepurchaseOfCommonStock: fact('CommonStockRepurchases', 'USD', [annual('2025-01-01', '2025-12-31', 80), annual('2024-01-01', '2024-12-31', 60), annual('2023-01-01', '2023-12-31', 45)]),
    OperatingIncomeLoss: fact('OperatingIncomeLoss', 'USD', [annual('2025-01-01', '2025-12-31', 220), annual('2024-01-01', '2024-12-31', 200), annual('2023-01-01', '2023-12-31', 180)]),
    InterestExpenseNonOperating: fact('InterestExpenseNonOperating', 'USD', [annual('2025-01-01', '2025-12-31', 55), annual('2024-01-01', '2024-12-31', 50), annual('2023-01-01', '2023-12-31', 60)]),
    Assets: fact('Assets', 'USD', [instant('2025-12-31', 1800), instant('2024-12-31', 1600)]),
    StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest: fact('Equity', 'USD', [instant('2025-12-31', 900), instant('2024-12-31', 750)]),
    NetCashProvidedByUsedInOperatingActivities: fact('OperatingCashFlow', 'USD', [annual('2025-01-01', '2025-12-31', 180)]),
    PaymentsToAcquirePropertyPlantAndEquipment: fact('Capex', 'USD', [annual('2025-01-01', '2025-12-31', -45)]),
    AssetsCurrent: fact('AssetsCurrent', 'USD', [instant('2025-12-31', 800)]),
    LiabilitiesCurrent: fact('LiabilitiesCurrent', 'USD', [instant('2025-12-31', 400)]),
    AccountsReceivableNetCurrent: fact('AccountsReceivableNetCurrent', 'USD', [instant('2025-12-31', 180), instant('2024-12-31', 150), instant('2023-12-31', 120)]),
    InventoryNet: fact('InventoryNet', 'USD', [instant('2025-12-31', 90), instant('2024-12-31', 95), instant('2023-12-31', 80)]),
    CashAndCashEquivalentsAtCarryingValue: fact('Cash', 'USD', [instant('2025-12-31', 300)]),
    LongTermDebtCurrent: fact('CurrentDebt', 'USD', [instant('2025-12-31', 40)]),
    LongTermDebtNoncurrent: fact('LongTermDebt', 'USD', [instant('2025-12-31', 210)]),
    LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths: fact('DebtMaturingNext12Months', 'USD', [instant('2025-12-31', 30)]),
    LongTermDebtMaturitiesRepaymentsOfPrincipalInYearTwo: fact('DebtMaturingYearTwo', 'USD', [instant('2025-12-31', 25)]),
    LongTermDebtMaturitiesRepaymentsOfPrincipalInYearThree: fact('DebtMaturingYearThree', 'USD', [instant('2025-12-31', 20)]),
    LongTermDebtMaturitiesRepaymentsOfPrincipalInYearFour: fact('DebtMaturingYearFour', 'USD', [instant('2025-12-31', 15)]),
    LongTermDebtMaturitiesRepaymentsOfPrincipalInYearFive: fact('DebtMaturingYearFive', 'USD', [instant('2025-12-31', 10)]),
    LongTermDebtMaturitiesRepaymentsOfPrincipalAfterYearFive: fact('DebtMaturingAfterYearFive', 'USD', [instant('2025-12-31', 100)])
  }, dei: { EntityCommonStockSharesOutstanding: fact('Shares', 'shares', [instant('2025-12-31', 500_000_000)]) } } };
}

test('SEC annual fundamentals use facts from the latest filed annual accession and preserve gaps', () => {
  const result = normalizeSecAnnualFundamentals('TEST', '123456', { filings: { recent: filing } }, companyFacts(), new Date('2026-09-24T12:00:00Z'));
  assert.equal(result.status, 'partial');
  assert.equal(result.filing.form, '10-K');
  assert.equal(result.filing.filedAt, '2026-02-15');
  assert.equal(result.filing.periodEnd, '2025-12-31');
  assert.equal(result.metrics.revenue.value, 1100);
  assert.deepEqual(result.metrics.revenue.history.map((row) => row.value), [1100, 1000, 900]);
  assert.ok(Math.abs(result.metrics.revenue.growthPct - 10) < 1e-9);
  assert.equal(result.metrics.freeCashFlow.value, 135);
  assert.equal(result.metrics.operatingCashConversion.value, 1.5);
  assert.equal(result.metrics.operatingCashConversion.unit, 'x');
  assert.deepEqual(result.metrics.operatingCashConversion.history.map((row) => row.value), [1.5]);
  assert.equal(result.metrics.operatingMarginPct.value, 20);
  assert.equal(result.metrics.grossMarginPct.value, 60);
  assert.ok(Math.abs(result.metrics.netMarginPct.value - (120 / 1100 * 100)) < 1e-9);
  assert.ok(Math.abs(result.metrics.freeCashFlowMarginPct.value - (135 / 1100 * 100)) < 1e-9);
  assert.equal(result.metrics.cash.value, 300);
  assert.equal(result.metrics.longTermDebtCurrent.value, 40);
  assert.equal(result.metrics.longTermDebtNoncurrent.value, 210);
  assert.equal(result.metrics.cashLessLongTermDebt.value, 50);
  assert.deepEqual(['debtMaturityNext12Months', 'debtMaturityYearTwo', 'debtMaturityYearThree', 'debtMaturityYearFour', 'debtMaturityYearFive', 'debtMaturityAfterYearFive']
    .map((key) => result.metrics[key].value), [30, 25, 20, 15, 10, 100]);
  assert.ok(['debtMaturityNext12Months', 'debtMaturityYearTwo', 'debtMaturityYearThree', 'debtMaturityYearFour', 'debtMaturityYearFive', 'debtMaturityAfterYearFive']
    .every((key) => result.metrics[key].periodEnd === '2025-12-31'));
  assert.equal(result.metrics.currentAssets.value, 800);
  assert.equal(result.metrics.currentLiabilities.value, 400);
  assert.equal(result.metrics.workingCapital.value, 400);
  assert.equal(result.metrics.currentRatio.value, 2);
  assert.equal(result.metrics.currentRatio.unit, 'x');
  assert.ok(Math.abs(result.metrics.returnOnEquityPct.value - (120 / 825 * 100)) < 1e-9);
  assert.equal(result.metrics.returnOnEquityPct.unit, 'percent');
  assert.ok(Math.abs(result.metrics.returnOnAssetsPct.value - (120 / 1700 * 100)) < 1e-9);
  assert.equal(result.metrics.totalAssets.value, 1800);
  assert.equal(result.metrics.stockholdersEquity.value, 900);
  assert.equal(result.metrics.accountsReceivable.value, 180);
  assert.ok(Math.abs(result.metrics.accountsReceivable.growthPct - 20) < 1e-9);
  assert.deepEqual(result.metrics.accountsReceivable.history.map((row) => row.value), [180, 150, 120]);
  assert.ok(Math.abs(result.metrics.receivablesRevenueGrowthGapPp.value - 10) < 1e-9);
  assert.equal(result.metrics.receivablesRevenueGrowthGapPp.unit, 'percentage_points');
  assert.equal(result.metrics.inventory.value, 90);
  assert.ok(Math.abs(result.metrics.inventory.growthPct - ((90 / 95 - 1) * 100)) < 1e-9);
  assert.equal(result.metrics.sharesOutstanding.value, 500_000_000);
  assert.equal(result.historicalValuationInputs.length, 1);
  assert.equal(result.historicalValuationInputs[0].filing.accession, accession);
  assert.equal(result.historicalValuationInputs[0].revenue.value, 1100);
  assert.equal(result.historicalValuationInputs[0].freeCashFlow.value, 135);
  assert.equal(result.metrics.weightedAverageDilutedShares.value, 520_000_000);
  assert.equal(result.metrics.weightedAverageDilutedShares.unit, 'shares');
  assert.ok(Math.abs(result.metrics.weightedAverageDilutedShares.growthPct - 4) < 1e-9);
  assert.deepEqual(result.metrics.weightedAverageDilutedShares.history.map((row) => row.value), [520_000_000, 500_000_000, 490_000_000]);
  assert.equal(result.metrics.dilutedEps.value, 2.4);
  assert.equal(result.metrics.dilutedEps.unit, 'USD/shares');
  assert.ok(Math.abs(result.metrics.dilutedEps.growthPct - 20) < 1e-9);
  assert.deepEqual(result.metrics.dilutedEps.history.map((row) => row.value), [2.4, 2, 1.8]);
  assert.equal(result.metrics.cashDividendsPerShare.value, 1.12);
  assert.equal(result.metrics.cashDividendsPerShare.unit, 'USD/shares');
  assert.deepEqual(result.metrics.cashDividendsPerShare.history.map((row) => row.value), [1.12, 1.04, 0.96]);
  assert.deepEqual(result.metrics.cashDividendsPaid.history.map((row) => row.value), [35, 32, 29]);
  assert.deepEqual(result.metrics.commonStockRepurchases.history.map((row) => row.value), [80, 60, 45]);
  assert.equal(result.metrics.operatingIncome.value, 220);
  assert.equal(result.metrics.interestExpense.value, 55);
  assert.equal(result.metrics.interestCoverageRatio.value, 4);
  assert.deepEqual(result.metrics.interestCoverageRatio.history.map((row) => Number(row.value.toFixed(2))), [4, 4, 3]);
  assert.match(result.filing.url, /sec\.gov\/Archives\/edgar\/data\/123456\/000012345626000001\/annual\.htm/);
  assert.ok(result.limitations.length >= 3);
  assert.equal(result.quarterly.status, 'unavailable');
});

test('historical valuation inputs use exact filing accessions and reject future annual filings', () => {
  const facts = companyFacts();
  const priorAccession = '0000123456-25-000001';
  facts.facts['us-gaap'].RevenueFromContractWithCustomerExcludingAssessedTax.units.USD.push({ start: '2024-01-01', end: '2024-12-31', val: 900, accn: priorAccession, form: '10-K', fy: 2024, fp: 'FY' });
  facts.facts['us-gaap'].NetIncomeLoss.units.USD.push({ start: '2024-01-01', end: '2024-12-31', val: 80, accn: priorAccession, form: '10-K', fy: 2024, fp: 'FY' });
  facts.facts['us-gaap'].NetCashProvidedByUsedInOperatingActivities.units.USD.push({ start: '2024-01-01', end: '2024-12-31', val: 140, accn: priorAccession, form: '10-K', fy: 2024, fp: 'FY' });
  facts.facts['us-gaap'].PaymentsToAcquirePropertyPlantAndEquipment.units.USD.push({ start: '2024-01-01', end: '2024-12-31', val: -30, accn: priorAccession, form: '10-K', fy: 2024, fp: 'FY' });
  facts.facts.dei.EntityCommonStockSharesOutstanding.units.shares.push({ end: '2024-12-31', val: 480_000_000, accn: priorAccession, form: '10-K', fy: 2024, fp: 'FY' });
  const submissions = { filings: { recent: {
    form: ['10-K', '10-K'], filingDate: ['2026-02-15', '2025-02-15'], reportDate: ['2025-12-31', '2024-12-31'],
    accessionNumber: [accession, priorAccession], primaryDocument: ['annual.htm', 'prior.htm']
  } } };
  const result = normalizeSecAnnualFundamentals('TEST', '123456', submissions, facts, new Date('2026-09-24T12:00:00Z'));
  assert.deepEqual(result.historicalValuationInputs.map((row) => row.filing.accession), [accession, priorAccession]);
  assert.deepEqual(result.historicalValuationInputs.map((row) => row.revenue.value), [1100, 900]);
  assert.deepEqual(result.historicalValuationInputs.map((row) => row.sharesOutstanding.value), [500_000_000, 480_000_000]);
  assert.equal(result.historicalValuationInputs[1].freeCashFlow.value, 110);

  const future = { filings: { recent: { ...submissions.filings.recent, filingDate: ['2026-12-15', '2025-02-15'] } } };
  const asOfEarlier = normalizeSecAnnualFundamentals('TEST', '123456', future, facts, new Date('2026-09-24T12:00:00Z'));
  assert.deepEqual(asOfEarlier.historicalValuationInputs.map((row) => row.filing.accession), [priorAccession]);
});

test('SEC annual ROE/ROA are unavailable without a period-aligned positive average balance', () => {
  const facts = companyFacts();
  facts.facts['us-gaap'].StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest.units.USD = [
    { end: '2025-12-31', val: -100, accn: accession, form: '10-K', fy: 2025, fp: 'FY' },
    { end: '2024-12-31', val: -200, accn: accession, form: '10-K', fy: 2024, fp: 'FY' }
  ];
  facts.facts['us-gaap'].Assets.units.USD = [
    { end: '2025-12-31', val: 1800, accn: accession, form: '10-K', fy: 2025, fp: 'FY' }
  ];
  const result = normalizeSecAnnualFundamentals('TEST', '123456', { filings: { recent: filing } }, facts, new Date('2026-09-24T12:00:00Z'));
  assert.equal(result.metrics.returnOnEquityPct.value, null);
  assert.equal(result.metrics.returnOnAssetsPct.value, null, 'average total assets are unavailable without prior year-end assets');
});

test('annual metric history excludes prior-year facts supplied only by another accession', () => {
  const facts = companyFacts();
  facts.facts['us-gaap'].RevenueFromContractWithCustomerExcludingAssessedTax.units.USD.push({
    start: '2024-01-01', end: '2024-12-31', val: 9999, accn: '0000123456-25-009999', form: '10-K', fy: 2024, fp: 'FY'
  });
  const result = normalizeSecAnnualFundamentals('TEST', '123456', { filings: { recent: filing } }, facts, new Date('2026-09-24T12:00:00Z'));
  assert.deepEqual(result.metrics.revenue.history.map((row) => row.value), [1100, 1000, 900]);
});

test('latest quarterly facts use only exact-period 10-Q facts from its filed accession', () => {
  const quarterAccession = '0000123456-26-000002';
  const facts = companyFacts();
  const add = (tag, unit, rows) => {
    const target = facts.facts['us-gaap'][tag];
    target.units[unit].push(...rows.map((row) => ({ ...row, accn: quarterAccession, form: '10-Q', fy: 2026, fp: 'Q2', filed: '2026-08-02' })));
  };
  add('RevenueFromContractWithCustomerExcludingAssessedTax', 'USD', [
    { start: '2026-04-01', end: '2026-06-30', val: 400 }, { start: '2025-04-01', end: '2025-06-30', val: 300 },
    { start: '2026-01-01', end: '2026-06-30', val: 999 }
  ]);
  add('GrossProfit', 'USD', [{ start: '2026-04-01', end: '2026-06-30', val: 240 }]);
  add('NetIncomeLoss', 'USD', [{ start: '2026-04-01', end: '2026-06-30', val: 45 }, { start: '2025-04-01', end: '2025-06-30', val: 30 }]);
  add('OperatingIncomeLoss', 'USD', [{ start: '2026-04-01', end: '2026-06-30', val: 80 }]);
  add('InterestExpenseNonOperating', 'USD', [{ start: '2026-04-01', end: '2026-06-30', val: -20 }]);
  add('NetCashProvidedByUsedInOperatingActivities', 'USD', [{ start: '2026-04-01', end: '2026-06-30', val: 55 }]);
  add('PaymentsToAcquirePropertyPlantAndEquipment', 'USD', [{ start: '2026-04-01', end: '2026-06-30', val: -10 }]);
  add('EarningsPerShareDiluted', 'USD/shares', [{ start: '2026-04-01', end: '2026-06-30', val: .9 }]);
  add('CommonStockDividendsPerShareCashPaid', 'USD/shares', [{ start: '2026-04-01', end: '2026-06-30', val: .28 }]);
  add('PaymentsOfDividendsCommonStock', 'USD', [{ start: '2026-04-01', end: '2026-06-30', val: 9 }]);
  add('PaymentsForRepurchaseOfCommonStock', 'USD', [{ start: '2026-04-01', end: '2026-06-30', val: 20 }]);
  const quarterInstant = (tag, value, unit = 'USD', taxonomy = 'us-gaap') => {
    const target = facts.facts[taxonomy][tag];
    target.units[unit].push({ end: '2026-06-30', val: value, accn: quarterAccession, form: '10-Q', fy: 2026, fp: 'Q2', filed: '2026-08-02' });
  };
  quarterInstant('AssetsCurrent', 900); quarterInstant('LiabilitiesCurrent', 450); quarterInstant('CashAndCashEquivalentsAtCarryingValue', 350);
  quarterInstant('LongTermDebtCurrent', 35); quarterInstant('LongTermDebtNoncurrent', 240); quarterInstant('EntityCommonStockSharesOutstanding', 505_000_000, 'shares', 'dei');
  const submissions = { filings: { recent: {
    form: ['10-K', '10-Q'], filingDate: ['2026-02-15', '2026-08-02'], reportDate: ['2025-12-31', '2026-06-30'],
    accessionNumber: [accession, quarterAccession], primaryDocument: ['annual.htm', 'quarter.htm']
  } } };
  const result = normalizeSecAnnualFundamentals('TEST', '123456', submissions, facts, new Date('2026-09-24T12:00:00Z'));
  assert.equal(result.filing.form, '10-K');
  assert.equal(result.quarterly.status, 'partial');
  assert.equal(result.quarterly.filing.form, '10-Q');
  assert.equal(result.quarterly.filing.periodEnd, '2026-06-30');
  assert.match(result.quarterly.filing.url, /000012345626000002\/quarter\.htm/);
  assert.equal(result.quarterly.metrics.revenue.value, 400);
  assert.equal(result.quarterly.metrics.revenue.periodStart, '2026-04-01');
  assert.equal(result.quarterly.metrics.cashDividendsPerShare.value, .28);
  assert.equal(result.quarterly.metrics.cashDividendsPerShare.periodEnd, '2026-06-30');
  assert.equal(result.quarterly.metrics.cashDividendsPaid.value, 9);
  assert.equal(result.quarterly.metrics.commonStockRepurchases.value, 20);
  assert.ok(Math.abs(result.quarterly.metrics.revenue.growthPct - (400 / 300 - 1) * 100) < 1e-9);
  assert.equal(result.quarterly.metrics.freeCashFlow.value, 45);
  assert.equal(result.quarterly.metrics.interestCoverageRatio.value, 4);
  assert.equal(result.quarterly.metrics.grossMarginPct.value, 60);
  assert.equal(result.quarterly.metrics.currentRatio.value, 2);
  assert.equal(result.quarterly.metrics.cashLessLongTermDebt.value, 75);
});

test('simplified interest coverage is unavailable when standardized facts have mismatched periods', () => {
  const facts = companyFacts();
  facts.facts['us-gaap'].InterestExpenseNonOperating.units.USD[0].start = '2025-02-01';
  const result = normalizeSecAnnualFundamentals('TEST', '123456', { filings: { recent: filing } }, facts, new Date('2026-09-24T12:00:00Z'));
  assert.equal(result.metrics.interestExpense.value, 55);
  assert.equal(result.metrics.interestCoverageRatio.value, null);
});

test('debt maturity buckets remain unavailable when absent or archived under a different filing accession', () => {
  const facts = companyFacts();
  const maturity = facts.facts['us-gaap'].LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths.units.USD[0];
  maturity.accn = '000012345625009999';
  const result = normalizeSecAnnualFundamentals('TEST', '123456', { filings: { recent: filing } }, facts, new Date('2026-09-24T12:00:00Z'));
  assert.equal(result.metrics.debtMaturityNext12Months.value, null);
  assert.equal(result.metrics.debtMaturityNext12Months.tag, 'LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths');
});

test('quarterly SEC facts ignore other accessions, cumulative periods, and future filings', () => {
  const quarterAccession = '0000123456-26-000002';
  const facts = companyFacts();
  facts.facts['us-gaap'].RevenueFromContractWithCustomerExcludingAssessedTax.units.USD.push(
    { start: '2026-01-01', end: '2026-06-30', val: 600, accn: quarterAccession, form: '10-Q', fy: 2026, fp: 'Q2', filed: '2026-08-02' },
    { start: '2026-04-01', end: '2026-06-30', val: 900, accn: '0000123456-26-000099', form: '10-Q', fy: 2026, fp: 'Q2', filed: '2026-08-02' },
    { start: '2026-04-01', end: '2026-06-30', val: 999, accn: quarterAccession, form: '10-Q', fy: 2026, fp: 'Q2', filed: '2026-12-02' }
  );
  const submissions = { filings: { recent: { form: ['10-K', '10-Q'], filingDate: ['2026-02-15', '2026-08-02'], reportDate: ['2025-12-31', '2026-06-30'], accessionNumber: [accession, quarterAccession] } } };
  const result = normalizeSecAnnualFundamentals('TEST', '123456', submissions, facts, new Date('2026-09-24T12:00:00Z'));
  assert.equal(result.quarterly.metrics.revenue.value, null);
  assert.equal(result.quarterly.metrics.netIncome.value, null);
});

test('receivables and inventory history only uses the selected annual filing accession', () => {
  const facts = companyFacts();
  facts.facts['us-gaap'].AccountsReceivableNetCurrent.units.USD[1].accn = '0000123456-25-000099';
  const result = normalizeSecAnnualFundamentals('TEST', '123456', { filings: { recent: filing } }, facts, new Date('2026-09-24T12:00:00Z'));
  assert.equal(result.metrics.accountsReceivable.value, 180);
  assert.deepEqual(result.metrics.accountsReceivable.history.map((row) => row.value), [180, 120]);
});

test('receivables growth comparison is withheld when prior fiscal period ends do not align', () => {
  const facts = companyFacts();
  facts.facts['us-gaap'].AccountsReceivableNetCurrent.units.USD[1].end = '2024-11-30';
  const result = normalizeSecAnnualFundamentals('TEST', '123456', { filings: { recent: filing } }, facts, new Date('2026-09-24T12:00:00Z'));
  assert.equal(result.metrics.receivablesRevenueGrowthGapPp.value, null);
});

test('derived SEC margins and free cash flow do not mix annual facts from different period ends', () => {
  const facts = companyFacts();
  facts.facts['us-gaap'].PaymentsToAcquirePropertyPlantAndEquipment.units.USD[0].end = '2025-12-30';
  facts.facts['us-gaap'].GrossProfit.units.USD[0].end = '2025-12-30';
  const result = normalizeSecAnnualFundamentals('TEST', '123456', { filings: { recent: filing } }, facts, new Date('2026-09-24T12:00:00Z'));
  assert.equal(result.metrics.freeCashFlow.value, null);
  assert.equal(result.metrics.freeCashFlowMarginPct.value, null);
  assert.equal(result.metrics.grossMarginPct.value, null);
  assert.equal(result.metrics.operatingMarginPct.value, 20);
});

test('annual free cash flow is withheld when the start dates differ despite matching fiscal end dates', () => {
  const facts = companyFacts();
  facts.facts['us-gaap'].PaymentsToAcquirePropertyPlantAndEquipment.units.USD[0].start = '2025-01-15';
  facts.facts['us-gaap'].NetCashProvidedByUsedInOperatingActivities.units.USD.push({
    start: '2024-01-01', end: '2024-12-31', val: 120, accn: accession, form: '10-K', fy: 2025, fp: 'FY'
  });
  facts.facts['us-gaap'].PaymentsToAcquirePropertyPlantAndEquipment.units.USD.push({
    start: '2024-01-01', end: '2024-12-31', val: -50, accn: accession, form: '10-K', fy: 2025, fp: 'FY'
  });
  const result = normalizeSecAnnualFundamentals('TEST', '123456', { filings: { recent: filing } }, facts, new Date('2026-09-24T12:00:00Z'));
  assert.equal(result.metrics.operatingCashFlow.periodEnd, result.metrics.capitalExpenditure.periodEnd);
  assert.notEqual(result.metrics.operatingCashFlow.periodStart, result.metrics.capitalExpenditure.periodStart);
  assert.equal(result.metrics.freeCashFlow.value, null);
  assert.deepEqual(result.metrics.freeCashFlow.history, [{ periodStart: '2024-01-01', periodEnd: '2024-12-31', value: 70 }]);
  assert.equal(result.metrics.freeCashFlowMarginPct.value, null);
});

test('current liquidity measures require period alignment and a positive denominator', () => {
  const facts = companyFacts();
  facts.facts['us-gaap'].AssetsCurrent.units.USD[0].end = '2025-12-30';
  let result = normalizeSecAnnualFundamentals('TEST', '123456', { filings: { recent: filing } }, facts, new Date('2026-09-24T12:00:00Z'));
  assert.equal(result.metrics.currentRatio.value, null);
  assert.equal(result.metrics.workingCapital.value, null);

  const zeroLiabilities = companyFacts();
  zeroLiabilities.facts['us-gaap'].LiabilitiesCurrent.units.USD[0].val = 0;
  result = normalizeSecAnnualFundamentals('TEST', '123456', { filings: { recent: filing } }, zeroLiabilities, new Date('2026-09-24T12:00:00Z'));
  assert.equal(result.metrics.workingCapital.value, 800);
  assert.equal(result.metrics.currentRatio.value, null);
});

test('operating cash conversion requires same-period standardized facts and positive net income', () => {
  const facts = companyFacts();
  facts.facts['us-gaap'].NetCashProvidedByUsedInOperatingActivities.units.USD[0].end = '2025-12-30';
  let result = normalizeSecAnnualFundamentals('TEST', '123456', { filings: { recent: filing } }, facts, new Date('2026-09-24T12:00:00Z'));
  assert.equal(result.metrics.operatingCashConversion.value, null);
  assert.deepEqual(result.metrics.operatingCashConversion.history, []);

  const loss = companyFacts();
  loss.facts['us-gaap'].NetIncomeLoss.units.USD[0].val = -10;
  result = normalizeSecAnnualFundamentals('TEST', '123456', { filings: { recent: filing } }, loss, new Date('2026-09-24T12:00:00Z'));
  assert.equal(result.metrics.operatingCashConversion.value, null);
  assert.deepEqual(result.metrics.operatingCashConversion.history, []);
});

test('future filings are excluded and non-positive prior earnings do not get misleading growth percentages', () => {
  const future = { filings: { recent: { ...filing, filingDate: ['2026-12-15'] } } };
  const noFiling = normalizeSecAnnualFundamentals('TEST', '123456', future, companyFacts(), new Date('2026-09-24T12:00:00Z'));
  assert.equal(noFiling.status, 'unavailable');
  const facts = companyFacts();
  facts.facts['us-gaap'].NetIncomeLoss.units.USD[0].val = -20;
  facts.facts['us-gaap'].NetIncomeLoss.units.USD[1].val = -100;
  const result = normalizeSecAnnualFundamentals('TEST', '123456', { filings: { recent: filing } }, facts, new Date('2026-09-24T12:00:00Z'));
  assert.equal(result.metrics.netIncome.growthPct, null);
});

test('diluted share history is unavailable when the reported fact is from another filing', () => {
  const facts = companyFacts();
  facts.facts['us-gaap'].WeightedAverageNumberOfDilutedSharesOutstanding.units.shares.forEach((row) => { row.accn = '0000123456-25-000099'; });
  facts.facts['us-gaap'].EarningsPerShareDiluted.units['USD/shares'].forEach((row) => { row.accn = '0000123456-25-000099'; });
  const result = normalizeSecAnnualFundamentals('TEST', '123456', { filings: { recent: filing } }, facts, new Date('2026-09-24T12:00:00Z'));
  assert.equal(result.metrics.weightedAverageDilutedShares.value, null);
  assert.deepEqual(result.metrics.weightedAverageDilutedShares.history, []);
  assert.equal(result.metrics.dilutedEps.value, null);
  assert.deepEqual(result.metrics.dilutedEps.history, []);
});
