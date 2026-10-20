import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readPaperRiskLedger } from '../shared/paperRisk.js';
import { resolvePaperLedgerPath } from '../shared/paperStatePath.js';
import { appendPaperTradeReview, resolvePaperTradeReviewPath } from '../shared/paperTradeReviewJournal.js';

try {
  if (process.argv.length !== 3) throw new Error('Usage: npm run review:paper -- <review-input.json>');
  const input = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
  const ledgerPath = resolvePaperLedgerPath(process.env.TRADING_RISK_STATE_PATH || '');
  const ledger = await readPaperRiskLedger({ statePath: ledgerPath });
  const record = await appendPaperTradeReview({
    journalPath: resolvePaperTradeReviewPath(ledgerPath), orders: ledger.orders, input,
  });
  console.log(JSON.stringify({ status: 'recorded', orderId: record.orderId, reviewId: record.reviewId,
    supersedesReviewId: record.supersedesReviewId, reviewedAt: record.reviewedAt,
    note: 'Manual assessment only; production strategy and risk gates are unchanged.' }, null, 2));
} catch (error) {
  console.error(`Paper trade review failed: ${error.message}`);
  process.exitCode = 1;
}
