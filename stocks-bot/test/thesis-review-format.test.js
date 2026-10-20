import test from 'node:test';
import assert from 'node:assert/strict';
import { annualHistoryFacts, formatAnnualHistory, latestAnnualTrendFacts } from '../src/thesisReviewFormat.js';

test('SEC thesis review captures and displays source-dated diluted-share history with financial trends', () => {
  const facts = annualHistoryFacts({ metrics: {
    revenue: { history: [{ periodEnd: '2024-12-31', value: 1000 }, { periodEnd: '2025-12-31', value: 1200 }] },
    operatingIncome: { tag: 'OperatingIncomeLoss' },
    interestExpense: { tag: 'InterestExpenseNonOperating', history: [{ periodStart: '2024-01-01', periodEnd: '2024-12-31', value: 50 }, { periodStart: '2025-01-01', periodEnd: '2025-12-31', value: 55 }] },
    interestCoverageRatio: { history: [{ periodStart: '2024-01-01', periodEnd: '2024-12-31', value: 4 }, { periodStart: '2025-01-01', periodEnd: '2025-12-31', value: 4 }] },
    weightedAverageDilutedShares: { history: [{ periodEnd: '2024-12-31', value: 10_000_000 }, { periodEnd: '2025-12-31', value: 11_000_000 }] },
    dilutedEps: { history: [{ periodEnd: '2025-12-31', value: 2.25 }] },
    cashDividendsPerShare: { tag: 'CommonStockDividendsPerShareCashPaid', history: [
      { periodStart: '2024-01-01', periodEnd: '2024-12-31', value: 0.96 }, { periodStart: '2025-01-01', periodEnd: '2025-12-31', value: 1.12 }
    ] },
    cashDividendsPaid: { tag: 'PaymentsOfDividendsCommonStock', history: [
      { periodStart: '2024-01-01', periodEnd: '2024-12-31', value: 32 }, { periodStart: '2025-01-01', periodEnd: '2025-12-31', value: 35 }
    ] },
    commonStockRepurchases: { tag: 'PaymentsForRepurchaseOfCommonStock', history: [
      { periodStart: '2024-01-01', periodEnd: '2024-12-31', value: 60 }, { periodStart: '2025-01-01', periodEnd: '2025-12-31', value: 80 }
    ] },
    freeCashFlow: { history: [{ periodEnd: '2025-12-31', value: null }] }
  } });

  assert.deepEqual(facts.filter((row) => row.key.includes('weightedAverageDilutedShares')).map((row) => [row.periodEnd, row.unit]), [
    ['2024-12-31', 'shares'], ['2025-12-31', 'shares']
  ]);
  assert.equal(facts.some((row) => row.key.includes('freeCashFlow')), false);
  assert.match(formatAnnualHistory(facts), /Revenue: 2024-12-31 \$1,000 → 2025-12-31 \$1,200/);
  assert.match(formatAnnualHistory(facts), /Reported interest expense: 2024-12-31 \$50 → 2025-12-31 \$55/);
  assert.match(formatAnnualHistory(facts), /Simplified operating income \/ interest expense: 2024-12-31 4\.00x → 2025-12-31 4\.00x/);
  assert.match(formatAnnualHistory(facts), /Weighted-average diluted shares: 2024-12-31 10\.0M shares → 2025-12-31 11\.0M shares/);
  assert.match(formatAnnualHistory(facts), /Diluted EPS: 2025-12-31 \$2\.25/);
  assert.match(formatAnnualHistory(facts), /Cash dividends paid per common share: 2024-12-31 \$0.96 → 2025-12-31 \$1.12/);
  assert.match(formatAnnualHistory(facts), /Reported cash dividends paid: 2024-12-31 \$32 → 2025-12-31 \$35/);
  assert.match(formatAnnualHistory(facts), /Reported common-stock repurchases: 2024-12-31 \$60 → 2025-12-31 \$80/);
  assert.equal(facts.find((row) => row.key === 'annual_history_cashDividendsPerShare_20241231').factSource,
    'SEC CommonStockDividendsPerShareCashPaid from the selected annual filing accession.');
  assert.equal(facts.find((row) => row.key === 'annual_history_interestCoverageRatio_20241231').factSource,
    'Calculated from SEC operating income OperatingIncomeLoss and interest expense InterestExpenseNonOperating.');
  assert.deepEqual(latestAnnualTrendFacts(facts).map((row) => row.periodEnd), Array(8).fill('2025-12-31'));
});

test('derived per-share histories require exact annual period alignment and positive diluted shares', () => {
  const facts = annualHistoryFacts({ metrics: {
    revenue: { history: [
      { periodStart: '2024-01-01', periodEnd: '2024-12-31', value: 1_000_000_000 },
      { periodStart: '2025-01-01', periodEnd: '2025-12-31', value: 1_200_000_000 }
    ] },
    freeCashFlow: { history: [
      { periodStart: '2024-01-01', periodEnd: '2024-12-31', value: 100_000_000 },
      { periodStart: '2025-01-01', periodEnd: '2025-12-30', value: 240_000_000 }
    ] },
    weightedAverageDilutedShares: { history: [
      { periodStart: '2024-01-01', periodEnd: '2024-12-31', value: 10_000_000 },
      { periodStart: '2025-01-01', periodEnd: '2025-12-31', value: 12_000_000 }
    ] }
  } });
  const revenuePerShare = facts.filter((row) => row.key.includes('revenuePerDilutedShare'));
  const fcfPerShare = facts.filter((row) => row.key.includes('freeCashFlowPerDilutedShare'));
  assert.deepEqual(revenuePerShare.map((row) => [row.periodEnd, row.value, row.unit]), [
    ['2024-12-31', 100, 'USD/shares'], ['2025-12-31', 100, 'USD/shares']
  ]);
  assert.deepEqual(fcfPerShare.map((row) => [row.periodEnd, row.value]), [['2024-12-31', 10]]);
  assert.match(formatAnnualHistory(facts), /Calculated free cash flow per diluted share: 2024-12-31 \$10/);
});

test('SEC cash-flow payment signs render in conventional currency order', () => {
  const facts = annualHistoryFacts({ metrics: { cashDividendsPaid: { tag: 'PaymentsOfDividendsCommonStock', history: [
    { periodStart: '2025-01-01', periodEnd: '2025-12-31', value: -35 }
  ] } } });
  assert.match(formatAnnualHistory(facts), /Reported cash dividends paid: 2025-12-31 -\$35/);
});

test('filing-dated debt maturity buckets are separately sourced and retained in thesis history', () => {
  const facts = annualHistoryFacts({ metrics: {
    debtMaturityNext12Months: { value: 30, unit: 'USD', periodEnd: '2025-12-31', tag: 'LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths' },
    debtMaturityYearTwo: { value: null, unit: 'USD', periodEnd: '2025-12-31', tag: 'LongTermDebtMaturitiesRepaymentsOfPrincipalInYearTwo' },
    debtMaturityAfterYearFive: { value: 100, unit: 'USD', periodEnd: '2025-12-31', tag: 'LongTermDebtMaturitiesRepaymentsOfPrincipalAfterYearFive' }
  } });
  assert.deepEqual(facts.map((row) => row.value), [30, 100]);
  assert.match(formatAnnualHistory(facts), /Reported principal due in next 12 months at filing date: 2025-12-31 \$30/);
  assert.match(formatAnnualHistory(facts), /Reported principal due after year 5 at filing date: 2025-12-31 \$100/);
  assert.equal(facts[0].factSource, 'SEC LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths from the selected annual filing accession.');
  assert.equal(latestAnnualTrendFacts(facts).length, 2);
});
