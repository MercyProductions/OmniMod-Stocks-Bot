import test from 'node:test';
import assert from 'node:assert/strict';
import { appendThesisAssessment, appendThesisEvidenceReview, appendThesisPerformanceSnapshot, appendThesisRevision, compareThesisGrowthEvidence, latestTheses, recentThesisAssessments, recentThesisEvidenceReviews, readThesisJournal, summarizeThesisPerformance, thesisEvidenceCoverage, thesisReviewPrompts, thesesDueForReview } from '../src/thesisJournal.js';
import { buildCommands } from '../src/commands.js';

function memory() {
  const files = new Map();
  return { files, readJson: async (file, fallback) => structuredClone(files.get(file) ?? fallback),
    writeJson: async (file, value) => { files.set(file, structuredClone(value)); } };
}
function input(patch = {}) { return { assetId: 'NVDA', thesisType: 'growth', horizonMonths: 36, reviewDate: '2099-01-01',
  thesis: 'Data-center demand may sustain durable revenue growth.', assumptions: 'Customers continue funding capacity growth and competition remains disciplined.',
  baseCase: 'Revenue and free cash flow grow at a slower pace than the recent peak.', bullCase: 'Growth, margins, and cash conversion persist without excessive dilution.',
  bearCase: 'Cycle peaks and customer concentration compress long-term returns.',
  invalidation: 'Two years of falling underlying demand and shrinking free cash flow.', catalysts: 'Next annual report; confirm its filing date independently.',
  sources: ['https://example.com/report'], ...patch }; }

test('personal stock thesis revisions are private, append-only, and grouped by ticker', async () => {
  const storage = memory(), options = { storage, file: 'stock-user', now: '2026-09-25T12:00:00Z' };
  const first = await appendThesisRevision('123456789', input(), options);
  const second = await appendThesisRevision('123456789', input({ thesis: 'Updated view after reviewing the latest report.' }), options);
  await appendThesisRevision('123456789', input({ assetId: 'MSFT' }), options);
  const saved = await readThesisJournal('123456789', options);
  assert.equal(first.entry.revision, 1);
  assert.equal(second.entry.revision, 2);
  assert.equal(saved.revisions.length, 3);
  assert.equal(saved.revisions[0].thesis, 'Data-center demand may sustain durable revenue growth.');
  assert.equal(latestTheses(saved).find((row) => row.assetId === 'NVDA').revision, 2);
});

test('stock thesis input validates horizon, risk fields, HTTPS sources, and malformed storage', async () => {
  const storage = memory(), options = { storage, file: 'validation' };
  await assert.rejects(appendThesisRevision('123456789', input({ assetId: 'NVDA!' }), options), /ticker/);
  await assert.rejects(appendThesisRevision('123456789', input({ invalidation: '' }), options), /invalidation/);
  await assert.rejects(appendThesisRevision('123456789', input({ sources: [] }), options), /at least one HTTPS source/);
  await assert.rejects(appendThesisRevision('123456789', input({ sources: ['http://example.com'] }), options), /HTTPS/);
  await assert.rejects(appendThesisRevision('123456789', input({ reviewDate: '2026-02-30' }), options), /Review date/);
  storage.files.set('damaged', { version: 2, userId: '123456789', revisions: [] });
  await assert.rejects(appendThesisRevision('123456789', input(), { storage, file: 'damaged' }), /invalid structure/);
  assert.equal(storage.files.get('damaged').version, 2);
});

test('stock due review view uses latest ticker revision and excludes future or invalid dates', async () => {
  const storage = memory(), options = { storage, file: 'stock-due-reviews' };
  await appendThesisRevision('123456789', input({ assetId: 'NVDA', reviewDate: '2026-09-20' }), options);
  await appendThesisRevision('123456789', input({ assetId: 'NVDA', reviewDate: '2026-10-01' }), options);
  await appendThesisRevision('123456789', input({ assetId: 'MSFT', reviewDate: '2026-09-24' }), options);
  await appendThesisRevision('123456789', input({ assetId: 'AMD', reviewDate: '2099-01-01' }), options);
  const journal = await readThesisJournal('123456789', options);
  journal.revisions.push({ ...journal.revisions[0], assetId: 'BAD', reviewDate: '2026-02-30', revision: 1 });
  const due = thesesDueForReview(journal, '2026-09-24');
  assert.deepEqual(due.map((row) => [row.assetId, row.reviewStatus, row.daysOverdue]), [['MSFT', 'DUE TODAY', 0]]);
  assert.throws(() => thesesDueForReview(journal, '2026-02-30'), /real calendar date/);
});

test('stock evidence reviews append source-dated facts to the current thesis and survive later revisions', async () => {
  const storage = memory(), options = { storage, file: 'stock-evidence-reviews', now: '2026-09-25T12:00:00Z' };
  await assert.rejects(appendThesisEvidenceReview('123456789', { assetId: 'NVDA', facts: [] }, options), /No saved thesis/);
  await appendThesisRevision('123456789', input(), options);
  const review = await appendThesisEvidenceReview('123456789', { assetId: 'NVDA', source: 'SEC EDGAR Company Facts', status: 'partial',
    observedAt: '2026-09-25T12:00:00Z', filing: { form: '10-K', filedAt: '2026-02-01', periodEnd: '2025-12-31', url: 'https://www.sec.gov/Archives/example' },
    quarterlyFiling: { form: '10-Q', filedAt: '2026-08-01', periodEnd: '2026-06-30', accession: 'abc', url: 'https://www.sec.gov/Archives/quarter' },
    facts: [{ key: 'revenue', label: 'Revenue', value: 1000, unit: 'USD', periodEnd: '2025-12-31' },
      { key: 'q_revenue', label: 'Latest quarter revenue', value: 300, unit: 'USD', periodStart: '2026-04-01', periodEnd: '2026-06-30' },
      { key: 'annual_history_revenue_20241231', label: 'Revenue annual history', value: 900, unit: 'USD', periodStart: '2024-01-01', periodEnd: '2024-12-31' },
      { key: 'valuation_price_to_sales', label: 'Indicative price / annual sales', value: 5.2, unit: 'x', periodEnd: '2026-09-24', factSource: 'Yahoo daily chart (public/unofficial)' },
      { key: 'netIncome', label: 'Net income', value: null, unit: 'USD' },
      { key: 'annual_history_revenuePerDilutedShare_20241231', label: 'Calculated revenue per diluted share annual history', value: 10, unit: 'USD/shares',
        periodStart: '2024-01-01', periodEnd: '2024-12-31', factSource: 'Calculated from SEC revenue and weighted-average diluted shares with exact matching annual period 2024-01-01|2024-12-31.' }] }, options);
  assert.equal(review.review.thesisRevision, 1);
  assert.equal(review.review.facts[0].value, 1000);
  assert.equal(review.review.facts[1].periodStart, '2026-04-01');
  assert.equal(review.review.facts[2].periodEnd, '2024-12-31');
  assert.equal(review.review.facts[3].factSource, 'Yahoo daily chart (public/unofficial)');
  assert.equal(review.review.quarterlyFiling.periodEnd, '2026-06-30');
  assert.equal(review.review.facts[4].value, null);
  assert.match(review.review.facts[5].factSource, /exact matching annual period 2024-01-01\|2024-12-31/);
  await appendThesisRevision('123456789', input({ thesis: 'Revision after reviewing new evidence.' }), options);
  const saved = await readThesisJournal('123456789', options);
  assert.equal(saved.reviews.length, 1);
  assert.equal(saved.revisions.length, 2);
  assert.equal(saved.reviews[0].thesisRevision, 1);
});

test('stock evidence history is asset-scoped, newest-first, and bounded', () => {
  const journal = { reviews: [
    { assetId: 'NVDA', observedAt: '2026-01-01T00:00:00Z', reviewNumber: 1 },
    { assetId: 'MSFT', observedAt: '2026-03-01T00:00:00Z' },
    { assetId: 'nvda', observedAt: '2026-02-01T00:00:00Z', reviewNumber: 2 },
    { assetId: 'NVDA', observedAt: '2026-03-01T00:00:00Z', reviewNumber: 3 },
    { assetId: 'NVDA', observedAt: '2026-04-01T00:00:00Z', reviewNumber: 4 }
  ] };
  assert.deepEqual(recentThesisEvidenceReviews(journal, 'nvda', 2).map((row) => row.reviewNumber), [4, 3]);
  assert.equal(recentThesisEvidenceReviews(journal, 'nvda', 100).length, 3);
});

test('stock growth comparison requires matching SEC metric, unit, source, and a newer reporting period', () => {
  const prior = { assetId: 'NVDA', source: 'SEC EDGAR Company Facts', observedAt: '2026-01-01T00:00:00Z', facts: [
    { key: 'revenue_growth_pct', label: 'Annual revenue growth', value: 20, unit: 'percent', periodEnd: '2024-12-31' },
    { key: 'q_revenue_growth_pct', label: 'Quarterly revenue growth', value: 10, unit: 'percent', periodEnd: '2025-09-30' },
    { key: 'revenue', label: 'Revenue', value: 100, unit: 'USD', periodEnd: '2024-12-31' }
  ] };
  const current = { assetId: 'nvda', source: 'SEC EDGAR Company Facts', observedAt: '2026-02-01T00:00:00Z', facts: [
    { key: 'revenue_growth_pct', label: 'Annual revenue growth', value: 25, unit: 'percent', periodEnd: '2025-12-31' },
    { key: 'q_revenue_growth_pct', label: 'Quarterly revenue growth', value: 8, unit: 'percent', periodEnd: '2025-09-30' },
    { key: 'revenue', label: 'Revenue', value: 200, unit: 'USD', periodEnd: '2025-12-31' }
  ] };
  assert.deepEqual(compareThesisGrowthEvidence(current, prior), [{ key: 'revenue_growth_pct', label: 'Annual revenue growth', priorValue: 20,
    currentValue: 25, changePercentagePoints: 5, priorPeriodEnd: '2024-12-31', currentPeriodEnd: '2025-12-31' }]);
  assert.deepEqual(compareThesisGrowthEvidence({ ...current, source: 'other' }, prior), []);
});

test('stock evidence coverage uses latest capture and counts only numeric observed facts', () => {
  const journal = { reviews: [
    { assetId: 'NVDA', observedAt: '2026-01-01T00:00:00Z', facts: [{ key: 'revenue', value: 100 }] },
    { assetId: 'NVDA', observedAt: '2026-02-01T00:00:00Z', source: 'SEC EDGAR Company Facts', filing: { periodEnd: '2025-12-31' }, facts: [
      { key: 'revenue', value: 200, periodEnd: '2024-12-31' }, { key: 'netIncome', value: null }, { key: 'q_revenue', value: 50, periodEnd: '2026-01-01' },
      { key: 'annual_history_debtMaturityNext12Months_20251231', label: 'Reported principal due in next 12 months at filing date', value: 30, periodEnd: '2025-12-31' },
      { key: 'annual_history_debtMaturityAfterYearFive_20251231', label: 'Reported principal due after year 5 at filing date', value: 100, periodEnd: '2025-12-31' },
      { key: 'valuation_price_to_sales', value: 5.2, unit: 'x' }, { key: 'valuation_price', value: 100, unit: 'USD', periodEnd: '2026-02-01' }
    ] }
  ] };
  const coverage = thesisEvidenceCoverage(journal, 'nvda');
  assert.equal(coverage.review.observedAt, '2026-02-01T00:00:00Z');
  assert.equal(coverage.fieldsObserved, 6);
  assert.equal(coverage.domains[0].status, 'partial');
  assert.equal(coverage.domains[0].latestPeriodEnd, '2024-12-31');
  assert.equal(coverage.domains[0].periodAgeDays, 397);
  assert.equal(coverage.domains[0].periodRelation, 'before_capture');
  assert.equal(coverage.domains[1].status, 'not observed');
  assert.deepEqual(coverage.domains[2], { label: 'Reported annual debt maturities', observed: 2, total: 6, status: 'partial',
    latestPeriodEnd: '2025-12-31', periodAgeDays: 32, periodRelation: 'before_capture' });
  assert.equal(coverage.domains[5].latestPeriodEnd, '2026-01-01');
  assert.equal(coverage.domains[5].periodAgeDays, 31);
  assert.deepEqual(coverage.domains.at(-1), { label: 'Price and indicative annual multiples', observed: 2, total: 6, status: 'partial',
    latestPeriodEnd: '2026-02-01', periodAgeDays: 0, periodRelation: 'before_capture' });
});

test('stock evidence coverage flags periods dated after their capture', () => {
  const coverage = thesisEvidenceCoverage({ reviews: [{ assetId: 'NVDA', observedAt: '2026-02-01T00:00:00Z', facts: [
    { key: 'valuation_price', value: 100, periodEnd: '2026-02-05' }
  ] }] }, 'NVDA');
  assert.equal(coverage.domains.at(-1).latestPeriodEnd, '2026-02-05');
  assert.equal(coverage.domains.at(-1).periodAgeDays, 4);
  assert.equal(coverage.domains.at(-1).periodRelation, 'after_capture');
});

test('stock thesis review prompts are tied to thesis type and fall back safely', () => {
  const valuePrompts = thesisReviewPrompts({ thesisType: 'value' });
  assert.equal(valuePrompts.length, 3);
  assert.match(valuePrompts[0], /normalized cash generation/i);
  assert.match(thesisReviewPrompts({ thesisType: 'unknown' })[0], /current fact most directly tests/i);
});

test('stock personal assessments append to and remain linked with the thesis revision', async () => {
  const storage = memory(), options = { storage, file: 'stock-assessments', now: '2026-09-25T12:00:00Z' };
  await assert.rejects(appendThesisAssessment('123456789', { assetId: 'AAPL', status: 'thesis_intact', notes: 'Evidence.' }, options), /No saved thesis/);
  await appendThesisRevision('123456789', input(), options);
  const first = await appendThesisAssessment('123456789', { assetId: 'NVDA', status: 'mixed', notes: 'Cash conversion improved, but dilution remains elevated.' }, options);
  await appendThesisRevision('123456789', input({ thesis: 'Revised thesis after reviewing cash conversion.' }), options);
  const second = await appendThesisAssessment('123456789', { assetId: 'NVDA', status: 'weakened', notes: 'FCF failed to recover as expected.' }, options);
  const saved = await readThesisJournal('123456789', options);
  assert.equal(first.entry.thesisRevision, 1);
  assert.equal(second.entry.thesisRevision, 2);
  assert.equal(saved.assessments.length, 2);
  assert.deepEqual(recentThesisAssessments(saved, 'nvda', 1).map((row) => row.status), ['weakened']);
  await assert.rejects(appendThesisAssessment('123456789', { assetId: 'NVDA', status: 'BUY', notes: 'Unsupported category.' }, options), /assessment/);
});

test('stock thesis performance snapshots are append-only, session-idempotent and benchmark-relative', async () => {
  const storage = memory(), options = { storage, file: 'stock-performance' };
  await appendThesisRevision('123456789', input({ horizonMonths: 1 }), options);
  const baseline = await appendThesisPerformanceSnapshot('123456789', { assetId: 'NVDA', source: 'Yahoo adjusted daily close',
    marketKey: 'Yahoo adjusted close | SPY aligned session', benchmarkSymbol: 'SPY', asOf: '2026-01-02', observedAt: '2026-01-03T00:00:00Z', assetPrice: 100, benchmarkPrice: 500 }, options);
  const duplicate = await appendThesisPerformanceSnapshot('123456789', { ...baseline.snapshot, assetId: 'NVDA', observedAt: '2026-01-04T00:00:00Z' }, options);
  assert.equal(duplicate.duplicate, true);
  const baselineSummary = summarizeThesisPerformance(baseline.journal, 'NVDA');
  assert.equal(baselineSummary.horizonTargetAsOf, '2026-02-02');
  assert.equal(baselineSummary.horizonOutcome, null);
  await appendThesisPerformanceSnapshot('123456789', { assetId: 'NVDA', source: 'Yahoo adjusted daily close',
    marketKey: 'Yahoo adjusted close | SPY aligned session', benchmarkSymbol: 'SPY', asOf: '2026-01-20', observedAt: '2026-01-21T00:00:00Z', assetPrice: 80, benchmarkPrice: 450 }, options);
  await appendThesisPerformanceSnapshot('123456789', { assetId: 'NVDA', source: 'Yahoo adjusted daily close',
    marketKey: 'Yahoo adjusted close | SPY aligned session', benchmarkSymbol: 'SPY', asOf: '2026-02-10', observedAt: '2026-02-11T00:00:00Z', assetPrice: 110, benchmarkPrice: 525 }, options);
  await appendThesisPerformanceSnapshot('123456789', { assetId: 'NVDA', source: 'Yahoo adjusted daily close',
    marketKey: 'Yahoo adjusted close | SPY aligned session', benchmarkSymbol: 'SPY', asOf: '2026-03-12', observedAt: '2026-03-13T00:00:00Z', assetPrice: 125, benchmarkPrice: 550 }, options);
  const journal = await readThesisJournal('123456789', options);
  const summary = summarizeThesisPerformance(journal, 'NVDA');
  assert.equal(summary.snapshots, 4);
  assert.ok(Math.abs(summary.assetReturnPct - 25) < 1e-9);
  assert.ok(Math.abs(summary.benchmarkReturnPct - 10) < 1e-9);
  assert.ok(Math.abs(summary.relativeReturnPp - 15) < 1e-9);
  assert.equal(summary.horizonOutcome.targetAsOf, '2026-02-02');
  assert.equal(summary.horizonOutcome.observedAsOf, '2026-02-10');
  assert.ok(Math.abs(summary.horizonOutcome.assetReturnPct - 10) < 1e-9);
  assert.ok(Math.abs(summary.horizonOutcome.benchmarkReturnPct - 5) < 1e-9);
  assert.ok(Math.abs(summary.horizonOutcome.relativeReturnPp - 5) < 1e-9);
  assert.ok(Math.abs(summary.assetObservedMaxDrawdownPct - (-20)) < 1e-9);
  assert.ok(Math.abs(summary.benchmarkObservedMaxDrawdownPct - (-10)) < 1e-9);
  assert.equal(summary.horizonComplete, true);
  await appendThesisRevision('123456789', input({ thesis: 'New thesis revision.' }), options);
  assert.equal(summarizeThesisPerformance(await readThesisJournal('123456789', options), 'NVDA').baseline, null);
});

test('thesis horizon target uses calendar months and clamps month-end dates', async () => {
  const storage = memory(), options = { storage, file: 'stock-month-end' };
  await appendThesisRevision('123456789', input({ horizonMonths: 1 }), options);
  const saved = await appendThesisPerformanceSnapshot('123456789', { assetId: 'NVDA', source: 'Yahoo adjusted daily close',
    marketKey: 'Yahoo adjusted close | SPY aligned session', benchmarkSymbol: 'SPY', asOf: '2026-01-31', observedAt: '2026-02-01T00:00:00Z', assetPrice: 100, benchmarkPrice: 500 }, options);
  assert.equal(summarizeThesisPerformance(saved.journal, 'NVDA').horizonTargetAsOf, '2026-02-28');
});

test('Stocks exposes a private add/list/show thesis command without admin permission', () => {
  const command = buildCommands().find((row) => row.name === 'stocks');
  const thesis = command.options.find((row) => row.name === 'thesis');
  assert.ok(thesis);
  assert.deepEqual(thesis.options.find((row) => row.name === 'action').choices.map((row) => row.value), ['add', 'list', 'show', 'due', 'review', 'history', 'coverage', 'performance', 'assess']);
  assert.ok(thesis.options.some((row) => row.name === 'assessment'));
  assert.ok(thesis.options.some((row) => row.name === 'assessment_notes'));
  assert.ok(thesis.options.some((row) => row.name === 'thesis_type'));
  assert.ok(thesis.options.some((row) => row.name === 'review_date'));
  assert.ok(thesis.options.length <= 25);
});
