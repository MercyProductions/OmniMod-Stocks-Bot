import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendSecFundamentalEvidence, createSecFundamentalCapture, readSecFundamentalEvidence } from '../src/secEvidenceJournal.js';

async function withDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-sec-evidence-'));
  try { await run(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

function evidenceRow({ accession = '000012345626000001', priceDate = '2026-09-23', status = 'partial' } = {}) {
  const metrics = Object.fromEntries(['revenue', 'grossProfit', 'netIncome', 'operatingIncome', 'operatingCashFlow', 'operatingCashConversion', 'capitalExpenditure', 'cashDividendsPerShare', 'cashDividendsPaid', 'commonStockRepurchases',
    'weightedAverageDilutedShares', 'dilutedEps', 'totalAssets', 'stockholdersEquity', 'returnOnEquityPct', 'returnOnAssetsPct',
    'currentAssets', 'currentLiabilities', 'accountsReceivable', 'inventory', 'receivablesRevenueGrowthGapPp', 'workingCapital', 'currentRatio',
    'cash', 'longTermDebtCurrent', 'longTermDebtNoncurrent', 'debtMaturityNext12Months', 'debtMaturityYearTwo', 'debtMaturityYearThree', 'debtMaturityYearFour', 'debtMaturityYearFive', 'debtMaturityAfterYearFive', 'sharesOutstanding', 'freeCashFlow',
    'grossMarginPct', 'operatingMarginPct', 'netMarginPct', 'freeCashFlowMarginPct', 'cashLessLongTermDebt']
    .map((key) => [key, { value: null, unit: key.endsWith('Pct') ? 'percent' : key === 'operatingCashConversion' || key === 'currentRatio' ? 'x' : key === 'receivablesRevenueGrowthGapPp' ? 'percentage_points' : 'USD' }]));
  metrics.receivablesRevenueGrowthGapPp = { value: 10, unit: 'percentage_points' };
  metrics.revenue = { value: 1200, priorValue: 1000, growthPct: 20, unit: 'USD', tag: 'RevenueFromContractWithCustomerExcludingAssessedTax',
    periodStart: '2025-01-01', periodEnd: '2025-12-31', history: [{ periodStart: '2025-01-01', periodEnd: '2025-12-31', value: 1200 }] };
  metrics.dilutedEps = { value: 2.2, unit: 'USD/shares', tag: 'EarningsPerShareDiluted' };
  metrics.cashDividendsPerShare = { value: 1.12, unit: 'USD/shares', tag: 'CommonStockDividendsPerShareCashPaid',
    periodStart: '2025-01-01', periodEnd: '2025-12-31', history: [{ periodStart: '2025-01-01', periodEnd: '2025-12-31', value: 1.12 }] };
  metrics.cashDividendsPaid = { value: 35, unit: 'USD', tag: 'PaymentsOfDividendsCommonStock' };
  metrics.commonStockRepurchases = { value: 80, unit: 'USD', tag: 'PaymentsForRepurchaseOfCommonStock' };
  metrics.debtMaturityNext12Months = { value: 30, unit: 'USD', tag: 'LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths', periodEnd: '2025-12-31' };
  metrics.totalAssets = { value: 1800, unit: 'USD', tag: 'Assets', periodEnd: '2025-12-31', history: [
    { periodEnd: '2025-12-31', value: 1800 }, { periodEnd: '2024-12-31', value: 1600 }] };
  metrics.stockholdersEquity = { value: 900, unit: 'USD', tag: 'StockholdersEquity', periodEnd: '2025-12-31', history: [
    { periodEnd: '2025-12-31', value: 900 }, { periodEnd: '2024-12-31', value: 750 }] };
  metrics.returnOnEquityPct = { value: 14.5, unit: 'percent', periodEnd: '2025-12-31', history: [{ periodEnd: '2025-12-31', value: 14.5 }] };
  metrics.returnOnAssetsPct = { value: 7.1, unit: 'percent', periodEnd: '2025-12-31', history: [{ periodEnd: '2025-12-31', value: 7.1 }] };
  metrics.ignoredCustomField = { value: 7, unit: 'USD', tag: 'UserDefined' };
  return { symbol: 'TEST', asOf: priceDate, rawClose: 21.5,
    annualFundamentals: { status, cik: '123456', filing: { form: '10-K', filedAt: '2026-02-15', periodEnd: '2025-12-31', accession,
      url: `https://www.sec.gov/Archives/edgar/data/123456/${accession}/annual.htm` },
      metrics },
    annualValuation: { status: 'estimated', marketCapEstimate: 10_000, priceToSales: 8.3, priceToEarnings: 12, priceToFreeCashFlow: null, freeCashFlowYieldPct: null } };
}

test('SEC filing facts are archived as append-only point-in-time captures with daily idempotency', async () => {
  await withDirectory(async (directory) => {
    const row = evidenceRow();
    const observedAt = new Date('2026-09-24T16:30:00Z');
    assert.deepEqual(await appendSecFundamentalEvidence([row], { directory, observedAt }), { added: 1, total: 1 });
    assert.deepEqual(await appendSecFundamentalEvidence([row], { directory, observedAt }), { added: 0, total: 1 });
    assert.deepEqual(await appendSecFundamentalEvidence([evidenceRow({ priceDate: '2026-09-24' })], { directory,
      observedAt: new Date('2026-09-25T16:30:00Z') }), { added: 1, total: 2 });
    assert.deepEqual(await appendSecFundamentalEvidence([evidenceRow({ accession: '000012345626000002', priceDate: '2026-09-24' })], { directory,
      observedAt: new Date('2026-09-26T16:30:00Z') }), { added: 1, total: 3 });

    const saved = await readSecFundamentalEvidence({ directory });
    assert.equal(saved.captures.length, 3);
    assert.equal(saved.captures[0].source, 'SEC EDGAR companyfacts');
    assert.equal(saved.captures[0].observedAt, observedAt.toISOString());
    assert.equal(saved.captures[0].metrics.revenue.history[0].value, 1200);
    assert.equal(saved.captures[0].metrics.dilutedEps.unit, 'USD/shares');
    assert.equal(saved.captures[0].metrics.cashDividendsPerShare.value, 1.12);
    assert.equal(saved.captures[0].metrics.cashDividendsPaid.value, 35);
    assert.equal(saved.captures[0].metrics.commonStockRepurchases.value, 80);
    assert.equal(saved.captures[0].metrics.debtMaturityNext12Months.value, 30);
    assert.equal(saved.captures[0].metrics.debtMaturityNext12Months.tag, 'LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths');
    assert.equal(saved.captures[0].metrics.returnOnEquityPct.value, 14.5);
    assert.equal(saved.captures[0].metrics.returnOnAssetsPct.history[0].value, 7.1);
    assert.equal(saved.captures[0].metrics.operatingCashConversion.unit, 'x');
    assert.equal(saved.captures[0].metrics.receivablesRevenueGrowthGapPp.unit, 'percentage_points');
    assert.equal(saved.captures[0].metrics.ignoredCustomField, undefined);
    assert.deepEqual(saved.captures[0].coverage.unavailable, ['grossProfit', 'netIncome', 'operatingIncome', 'operatingCashFlow', 'operatingCashConversion', 'capitalExpenditure',
      'weightedAverageDilutedShares', 'currentAssets', 'currentLiabilities', 'accountsReceivable', 'inventory', 'workingCapital', 'currentRatio', 'cash', 'longTermDebtCurrent',
      'longTermDebtNoncurrent', 'debtMaturityYearTwo', 'debtMaturityYearThree', 'debtMaturityYearFour', 'debtMaturityYearFive', 'debtMaturityAfterYearFive', 'sharesOutstanding', 'freeCashFlow', 'grossMarginPct', 'operatingMarginPct', 'netMarginPct', 'freeCashFlowMarginPct', 'cashLessLongTermDebt']);
  });
});

test('concurrent SEC evidence appends preserve all distinct captures', async () => {
  await withDirectory(async (directory) => {
    const first = evidenceRow();
    const second = evidenceRow({ priceDate: '2026-09-24' });
    const results = await Promise.all([
      appendSecFundamentalEvidence([first], { directory, observedAt: new Date('2026-09-24T16:30:00Z') }),
      appendSecFundamentalEvidence([second], { directory, observedAt: new Date('2026-09-25T16:30:00Z') })
    ]);
    assert.equal(results.reduce((sum, result) => sum + result.added, 0), 2);
    assert.equal((await readSecFundamentalEvidence({ directory })).captures.length, 2);
  });
});

test('unavailable SEC rows are skipped and damaged archives are never overwritten', async () => {
  await withDirectory(async (directory) => {
    assert.equal(createSecFundamentalCapture(evidenceRow({ status: 'unavailable' })), null);
    assert.deepEqual(await appendSecFundamentalEvidence([evidenceRow({ status: 'coverage_limited' })], { directory }), { added: 0, total: null });
    const file = path.join(directory, 'sec-fundamental-evidence.json');
    await fs.writeFile(file, '{broken', 'utf8');
    await assert.rejects(appendSecFundamentalEvidence([evidenceRow()], { directory }), /Unable to read stored JSON/);
    assert.equal(await fs.readFile(file, 'utf8'), '{broken');
  });
});
