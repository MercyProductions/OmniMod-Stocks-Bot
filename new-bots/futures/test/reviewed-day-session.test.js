import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareFuturesDaySessionDraft } from '../src/prepareDaySessionDraft.js';
import { buildFuturesDaySessionReviewTemplate, compileReviewedFuturesDaySession, fingerprintFuturesDraft } from '../src/reviewedDaySession.js';

const now = Date.parse('2026-09-30T15:00:00.000Z');
const definitions = [{ product: 'E-mini S&P 500', providerSymbol: 'ES.v.0', providerRawSymbol: 'ESZ6', providerInstrumentId: '12345',
  providerPublisherId: '1', providerExchange: 'XCME', expiry: '2026-12-18T14:30:00.000Z', definitionTimestamp: '2026-09-30T14:00:00.000Z' }];
const products = [{ symbol: 'E-mini S&P 500', providerSymbol: 'ES.v.0', assetClass: 'equity-index-future', underlying: 'S&P 500' }];
const draft = prepareFuturesDaySessionDraft(definitions, products, { now });
const draftContents = JSON.stringify(draft, null, 2);
const review = () => ({ schemaVersion: 1, draftSha256: fingerprintFuturesDraft(draftContents), sessionDate: '2026-09-30', approvals: [{
  providerRawSymbol: 'ESZ6',
  contract: { contractId: 'XCME:12345', exposureKey: 'SPY', activeContract: true, contractSpecVerified: true,
    expiry: '2026-12-18T14:30:00.000Z', specSource: 'https://www.cmegroup.com/markets/equities/sp/e-mini-sandp500.contractSpecs.html',
    specVerifiedAt: new Date(now).toISOString(), tickSize: 0.25, tickValueUsd: 12.5, multiplier: 50,
    initialMarginUsd: 15_000, maintenanceMarginUsd: 13_500,
    settlementReview: { settlementType: 'cash_settled', source: 'https://www.cmegroup.com/markets/equities/sp/e-mini-sandp500.contractSpecs.html',
      reviewedAt: new Date(now).toISOString(), lastTradeAt: '2026-12-18T14:30:00.000Z' } },
  session: { marketDate: '2026-09-30', timeZone: 'America/Chicago', openTime: '2026-09-30T13:30:00.000Z',
    closeTime: '2026-09-30T20:00:00.000Z', source: 'https://www.cmegroup.com/markets/equities/sp/e-mini-sandp500.calendar.html', reviewedAt: new Date(now).toISOString() },
  catalystReview: { status: 'clear', source: 'https://www.cmegroup.com/market-data/economic-calendar.html',
    summary: 'Reviewed scheduled US releases and CME notices for this session.', reviewedAt: new Date(now).toISOString() },
  costs: { roundTripFeesPerContract: 4.5, slippageReservePerContract: 2 },
}] });

test('dataset/root provenance survives draft review and cannot be replaced by approval input', () => {
  const sourced = prepareFuturesDaySessionDraft(definitions.map((d) => ({ ...d, providerDataset: 'GLBX.MDP3', providerRoot: 'ES' })), products, { now });
  const sha = fingerprintFuturesDraft(JSON.stringify(sourced));
  const approval = review(); approval.draftSha256 = sha;
  Object.assign(approval.approvals[0].contract, { providerDataset: 'OTHER', providerRoot: 'WRONG', providerPublisherId: '999' });
  const compiled = compileReviewedFuturesDaySession(sourced, approval, { draftSha256: sha, now });
  assert.equal(compiled.dayTrades[0].contract.providerDataset, 'GLBX.MDP3');
  assert.equal(compiled.dayTrades[0].contract.providerRoot, 'ES');
  assert.equal(compiled.dayTrades[0].contract.providerPublisherId, '1');
});

test('review compiler emits paper-runner inputs only after the exact draft and every current review gate pass', () => {
  const compiled = compileReviewedFuturesDaySession(draft, review(), { draftSha256: fingerprintFuturesDraft(draftContents), now });
  assert.equal(compiled.reviewCompilation.status, 'operator-reviewed-inputs');
  assert.equal(compiled.dayTrades.length, 1);
  const [row] = compiled.dayTrades;
  assert.equal(row.preparationStatus, 'operator_reviewed_paper_input');
  assert.equal(row.contract.contractMode, 'active-contract');
  assert.equal(row.contract.providerRawSymbol, 'ESZ6');
  assert.equal(row.contract.providerInstrumentId, '12345');
  assert.equal(row.quote, null);
  assert.deepEqual(row.bars, []);
  assert.equal(row.config.roundTripFeesPerContract, 4.5);
  assert.equal(compiled.reviewCompilation.note.includes('live trading is not enabled'), true);
});

test('review compiler rejects changed drafts, expired/stale metadata, non-clear catalysts, unsafe sources and missing costs', () => {
  const changed = `${draftContents} `;
  assert.throws(() => compileReviewedFuturesDaySession(draft, review(), { draftSha256: fingerprintFuturesDraft(changed), now }), /fingerprint/);
  const stale = review(); stale.approvals[0].session.reviewedAt = '2026-09-28T15:00:00.000Z';
  assert.throws(() => compileReviewedFuturesDaySession(draft, stale, { draftSha256: fingerprintFuturesDraft(draftContents), now }), /rejected 1/);
  const blocked = review(); blocked.approvals[0].catalystReview.status = 'blocked';
  assert.throws(() => compileReviewedFuturesDaySession(draft, blocked, { draftSha256: fingerprintFuturesDraft(draftContents), now }), /rejected 1/);
  const unsafe = review(); unsafe.approvals[0].catalystReview.source = 'https://example.com/review?token=secret';
  assert.throws(() => compileReviewedFuturesDaySession(draft, unsafe, { draftSha256: fingerprintFuturesDraft(draftContents), now }), /rejected 1/);
  const noCosts = review(); noCosts.approvals[0].costs.slippageReservePerContract = null;
  assert.throws(() => compileReviewedFuturesDaySession(draft, noCosts, { draftSha256: fingerprintFuturesDraft(draftContents), now }), /rejected 1/);
});

test('review template is bound to the draft and never pre-approves any contract or review gate', () => {
  const hash = fingerprintFuturesDraft(draftContents);
  const template = buildFuturesDaySessionReviewTemplate(draft, hash);
  assert.equal(template.draftSha256, hash);
  assert.equal(template.approvals.length, 1);
  assert.equal(template.approvals[0].providerRawSymbol, 'ESZ6');
  assert.equal(template.approvals[0].contract.activeContract, false);
  assert.equal(template.approvals[0].contract.contractSpecVerified, false);
  assert.equal(template.approvals[0].session.marketDate, null);
  assert.equal(template.approvals[0].catalystReview.status, null);
  assert.equal(template.approvals[0].costs.roundTripFeesPerContract, null);
  assert.throws(() => compileReviewedFuturesDaySession(draft, template, { draftSha256: hash, now }), /rejected 1/);
});
