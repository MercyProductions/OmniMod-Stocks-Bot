import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendPaperTradeReview, readPaperTradeReviews, resolvePaperTradeReviewPath } from '../paperTradeReviewJournal.js';
import { buildResearchDashboard } from '../researchDashboard.js';

const now = Date.parse('2026-10-01T17:00:00Z');
const order = { orderId: 'paper-1', owner: 'stocks', instrumentKey: 'AAPL', strategyId: 'opening_range',
  status: 'closed', closedAt: '2026-10-01T16:00:00Z', filledAt: '2026-10-01T15:30:00Z',
  quoteTime: '2026-10-01T15:29:00Z', realizedPnlUsd: -8, grossPnlUsd: -7,
  feesUsd: 0.5, slippageUsd: 0.5, riskUsd: 10, exitReason: 'stop' };
const initial = { orderId: 'paper-1', reviewer: 'research lead', thesisValidity: 'uncertain',
  lossCause: 'undetermined', evidenceBasis: 'paper_ledger', evidenceAsOf: order.closedAt,
  summary: 'The observed quote path is insufficient to establish why the setup failed.' };

test('append-only paper reviews bind to a closed order and require an explicit latest-revision link', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-review-journal-'));
  const journalPath = resolvePaperTradeReviewPath(join(directory, 'ledger.json'));
  try {
    const first = await appendPaperTradeReview({ journalPath, orders: [order], input: initial, now });
    assert.equal(first.supersedesReviewId, null);
    const before = await readPaperTradeReviews({ journalPath, orders: [order] });
    assert.equal(before.diagnostics.accepted, 1);
    assert.equal(before.latestByOrder['paper-1'].reviewId, first.reviewId);
    await assert.rejects(appendPaperTradeReview({ journalPath, orders: [order], input: initial, now: now + 1_000 }), /supersede/);
    const revised = await appendPaperTradeReview({ journalPath, orders: [order], now: now + 2_000,
      input: { ...initial, supersedesReviewId: first.reviewId, thesisValidity: 'valid',
        lossCause: 'valid_setup_lost', evidenceBasis: 'external_https',
        sourceUrl: 'https://example.org/research/aapl-session',
        summary: 'Reviewed the recorded entry and independent session prices; no gate failure was established.' } });
    const readBack = await readPaperTradeReviews({ journalPath, orders: [order] });
    assert.equal(readBack.diagnostics.accepted, 2);
    assert.equal(readBack.latestByOrder['paper-1'].reviewId, revised.reviewId);
    const report = buildResearchDashboard({ ledger: { orders: [order] }, reviewJournal: readBack });
    assert.equal(report.postTradeReview.thesisReviewsCompleted, 1);
    assert.equal(report.postTradeReview.reviewJournalStatus, 'read_cleanly');
    assert.equal(report.postTradeReview.unresolvedLossCauses, 0);
    assert.equal(report.postTradeReview.reviewQueue.length, 0);
    assert.equal(report.postTradeReview.limitation.includes('not independently proven causes'), true);
    assert.equal(report.postTradeReview.observedFlagCounts.modeled_stop_exit, 1);
    assert.equal(report.postTradeReview.closedTrades, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('changed order facts and malformed journal records cannot become current assessments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-review-integrity-'));
  const journalPath = resolvePaperTradeReviewPath(join(directory, 'ledger.json'));
  try {
    await appendPaperTradeReview({ journalPath, orders: [order], input: initial, now });
    const changed = await readPaperTradeReviews({ journalPath, orders: [{ ...order, realizedPnlUsd: -9 }] });
    assert.equal(changed.diagnostics.missingOrChangedOrder, 1);
    assert.equal(Object.keys(changed.latestByOrder).length, 0);
    const changedReport = buildResearchDashboard({ ledger: { orders: [{ ...order, realizedPnlUsd: -9 }] }, reviewJournal: changed });
    assert.equal(changedReport.postTradeReview.reviewJournalStatus, 'needs_attention');
    assert.equal(changedReport.postTradeReview.unresolvedLossCauses, 1);
    await assert.rejects(appendPaperTradeReview({ journalPath, orders: [{ ...order, realizedPnlUsd: -9 }], input: initial, now: now + 1_000 }), /invalid or stale/);
    const original = await readFile(journalPath, 'utf8');
    await writeFile(journalPath, `${original}{malformed json}\n`);
    const malformed = await readPaperTradeReviews({ journalPath, orders: [order] });
    assert.equal(malformed.diagnostics.invalid, 1);
    await assert.rejects(appendPaperTradeReview({ journalPath, orders: [order], input: { ...initial, supersedesReviewId: malformed.latestByOrder['paper-1'].reviewId }, now: now + 1_000 }), /invalid or stale/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('manual causes require a losing order and bounded source evidence; no review can open a trade', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-review-validate-'));
  const journalPath = resolvePaperTradeReviewPath(join(directory, 'ledger.json'));
  try {
    await assert.rejects(appendPaperTradeReview({ journalPath, orders: [{ ...order, status: 'open' }], input: initial, now }), /closed paper order/);
    await assert.rejects(appendPaperTradeReview({ journalPath, orders: [order], input: { ...initial, lossCause: 'strategy_bug', evidenceBasis: 'external_https', sourceUrl: 'https://example.org/?token=secret' }, now }), /credential-free HTTPS/);
    await assert.rejects(appendPaperTradeReview({ journalPath, orders: [{ ...order, realizedPnlUsd: 2 }], input: initial, now }), /net outcome/);
    assert.equal(await readFile(journalPath, 'utf8').catch((error) => error.code), 'ENOENT');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
