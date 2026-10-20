import test from 'node:test';
import assert from 'node:assert/strict';
import { appendThesisAssessment, appendThesisEvidenceReview, appendThesisPerformanceSnapshot, appendThesisRevision, compareProtocolActivityCaptures, latestTheses, recentThesisAssessments, recentThesisEvidenceReviews, readThesisJournal, summarizeProtocolActivityHistory, summarizeThesisPerformance, thesisEvidenceCoverage, thesisReviewPrompts, thesesDueForReview } from '../src/thesisJournal.js';
import { buildCommands } from '../src/commands.js';
import { cryptoEvidenceFactSource } from '../src/thesisEvidence.js';

function memory() {
  const files = new Map();
  return { files, readJson: async (file, fallback) => structuredClone(files.get(file) ?? fallback),
    writeJson: async (file, value) => { files.set(file, structuredClone(value)); } };
}
function input(patch = {}) { return { assetId: 'ethereum', thesisType: 'network_adoption', horizonMonths: 36, reviewDate: '2099-01-01', protocolSlug: 'uniswap',
  thesis: 'Network demand could create durable token demand.', assumptions: 'Value accrues to this asset rather than only to applications.',
  baseCase: 'Usage grows gradually while issuance remains manageable.', bullCase: 'Usage and fee revenue grow without incentives.',
  bearCase: 'Usage is mostly subsidized and token value capture is weak.',
  invalidation: 'Sustained fee decline with no independent usage recovery.', catalysts: 'Upcoming protocol upgrade; verify its release date.',
  sources: ['https://example.com/report'], ...patch }; }

test('private thesis revisions append immutably and latest view selects the newest revision per asset', async () => {
  const storage = memory(), options = { storage, file: 'alice', now: '2026-09-25T12:00:00Z' };
  const first = await appendThesisRevision('123456789', input(), options);
  const second = await appendThesisRevision('123456789', input({ thesis: 'Usage grew but token capture remains uncertain.', githubRepo: 'Uniswap/v4-core' }), options);
  const other = await appendThesisRevision('123456789', input({ assetId: 'bitcoin', horizonMonths: 60 }), options);
  assert.equal(first.entry.revision, 1);
  assert.equal(second.entry.revision, 2);
  assert.equal(second.entry.protocolSlug, 'uniswap');
  assert.equal(second.entry.githubRepo, 'Uniswap/v4-core');
  assert.equal(other.entry.revision, 1);
  const saved = await readThesisJournal('123456789', options);
  assert.equal(saved.revisions.length, 3);
  assert.equal(saved.revisions[0].thesis, 'Network demand could create durable token demand.');
  assert.deepEqual(latestTheses(saved).map((row) => row.assetId), ['bitcoin', 'ethereum']);
  assert.equal(latestTheses(saved).find((row) => row.assetId === 'ethereum').revision, 2);
});

test('thesis input validates risk fields, horizon and HTTPS provenance before storing', async () => {
  const storage = memory(), options = { storage, file: 'validation' };
  await assert.rejects(appendThesisRevision('123456789', input({ bearCase: '' }), options), /bearCase/);
  await assert.rejects(appendThesisRevision('123456789', input({ horizonMonths: 0 }), options), /Horizon/);
  await assert.rejects(appendThesisRevision('123456789', input({ sources: ['http://example.com'] }), options), /HTTPS/);
  await assert.rejects(appendThesisRevision('123456789', input({ sources: ['https://'] }), options), /HTTPS/);
  await assert.rejects(appendThesisRevision('123456789', input({ sources: [] }), options), /at least one HTTPS source/);
  await assert.rejects(appendThesisRevision('123456789', input({ thesisType: 'compounder' }), options), /thesis type/);
  await assert.rejects(appendThesisRevision('123456789', input({ reviewDate: '2026-02-30' }), options), /Review date/);
  await assert.rejects(appendThesisRevision('123456789', input({ protocolSlug: 'https://example.com' }), options), /protocol slug/i);
  await assert.rejects(appendThesisRevision('123456789', input({ githubRepo: 'https://github.com/owner/repo' }), options), /exact public owner\/repo/);
  assert.equal(storage.files.size, 0);
});

test('due review view uses only each asset latest revision and excludes future or invalid dates', async () => {
  const storage = memory(), options = { storage, file: 'due-reviews' };
  await appendThesisRevision('123456789', input({ assetId: 'ethereum', reviewDate: '2026-09-20' }), options);
  await appendThesisRevision('123456789', input({ assetId: 'ethereum', reviewDate: '2026-10-01' }), options);
  await appendThesisRevision('123456789', input({ assetId: 'bitcoin', reviewDate: '2026-09-24' }), options);
  await appendThesisRevision('123456789', input({ assetId: 'cardano', reviewDate: '2026-09-20' }), options);
  await appendThesisRevision('123456789', input({ assetId: 'solana', reviewDate: '2099-01-01' }), options);
  const journal = await readThesisJournal('123456789', options);
  journal.revisions.push({ ...journal.revisions[0], assetId: 'bad-date', reviewDate: '2026-02-30', revision: 1 });
  const due = thesesDueForReview(journal, '2026-09-24');
  assert.deepEqual(due.map((row) => [row.assetId, row.reviewStatus, row.daysOverdue]), [['cardano', 'OVERDUE', 4], ['bitcoin', 'DUE TODAY', 0]]);
  assert.throws(() => thesesDueForReview(journal, '2026-02-30'), /real calendar date/);
});

test('malformed thesis storage is preserved and concurrent revisions are not lost', async () => {
  const storage = memory(), options = { storage, file: 'concurrent' };
  await Promise.all(Array.from({ length: 8 }, (_, i) => appendThesisRevision('123456789', input({ thesis: `Revision ${i}` }), options)));
  assert.equal((await readThesisJournal('123456789', options)).revisions.length, 8);
  storage.files.set('damaged', { version: 2, userId: '123456789', revisions: [] });
  await assert.rejects(appendThesisRevision('123456789', input(), { storage, file: 'damaged' }), /invalid structure/);
  assert.equal(storage.files.get('damaged').version, 2);
});

test('Crypto evidence reviews append provider snapshots to the matching thesis and preserve missing facts', async () => {
  const storage = memory(), options = { storage, file: 'crypto-evidence-reviews', now: '2026-09-25T12:00:00Z' };
  await appendThesisRevision('123456789', input({ assetId: 'ethereum' }), options);
  const first = await appendThesisEvidenceReview('123456789', { assetId: 'ETHEREUM', source: 'CoinGecko', status: 'coverage_limited',
    observedAt: '2026-09-25T12:00:00Z', providerAsOf: '2026-09-25T11:59:00Z', githubSummary: { repository: 'Uniswap/v4-core', status: 'available', recentCommits: 7, priorCommits: 5, recentContributors: 2, priorContributors: 2, observedAt: '2026-09-25T12:00:00Z' }, protocolSummary: { slug: 'aave', tvlStatus: 'available; latest point 0d old', financialStatus: 'request failed', usageStatus: 'partial; 2 reported fields; 1 request(s) failed', security: { status: 'available', protocolId: 'parent#aave', observedAt: '2026-09-25T12:00:00Z', incidentCount: 1, events: [{ date: '2024-01-01T00:00:00Z', classification: 'Protocol Logic', technique: 'Bad accounting', amountUsd: 2500, chains: ['Ethereum'], source: 'https://example.com/report' }] }, emissions: { available: true, lastModified: '2026-09-25', eventCount: 1,
      upcomingEvents: [{ date: '2026-10-01T00:00:00.000Z', category: 'contributors', tokenAmount: 42 }] }, allocation: { current: { insiders: 12 } } }, facts: [
      { key: 'circulating_supply', label: 'Reported circulating supply', value: 100, unit: 'tokens' },
      { key: 'unlock_schedule', label: 'Unlock schedule', value: null, unit: 'unavailable' }
    ] }, options);
  const second = await appendThesisEvidenceReview('123456789', { assetId: 'ethereum', source: 'CoinGecko', status: 'coverage_limited',
    observedAt: '2026-09-26T12:00:00Z', providerAsOf: '2026-09-26T11:59:00Z', facts: [] }, options);
  assert.equal(first.review.thesisRevision, 1);
  assert.equal(first.review.facts[1].value, null);
  assert.equal(first.review.protocolSummary.emissions.upcomingEvents[0].tokenAmount, 42);
  assert.equal(first.review.protocolSummary.allocation.current.insiders, 12);
  assert.equal(first.review.protocolSummary.tvlStatus, 'available; latest point 0d old');
  assert.equal(first.review.protocolSummary.financialStatus, 'request failed');
  assert.equal(first.review.protocolSummary.usageStatus, 'partial; 2 reported fields; 1 request(s) failed');
  assert.equal(first.review.protocolSummary.security.incidentCount, 1);
  assert.equal(first.review.protocolSummary.security.events[0].amountUsd, 2500);
  assert.equal(first.review.githubSummary.repository, 'Uniswap/v4-core');
  assert.equal(first.review.githubSummary.recentCommits, 7);
  const sourced = await appendThesisEvidenceReview('123456789', { assetId: 'ethereum', source: 'CoinGecko', status: 'partial',
    observedAt: '2026-09-27T12:00:00Z', githubSummary: { repository: 'Uniswap/v4-core', status: 'available', recentCommits: 7, recentContributors: 2 },
    facts: [{ key: 'protocol_active_users_24h', label: 'Active users', value: 10, unit: 'users', factSource: 'DeFiLlama Pro protocol activity endpoint' },
      { key: 'github_commits_recent_90d', label: 'Recent GitHub commits', value: 7, unit: 'commits' }] }, options);
  assert.equal(sourced.review.facts[0].factSource, 'DeFiLlama Pro protocol activity endpoint');
  const coverage = thesisEvidenceCoverage(await readThesisJournal('123456789', options), 'ethereum');
  assert.equal(coverage.github.repository, 'Uniswap/v4-core');
  assert.equal(coverage.domains.find((row) => row.label === 'GitHub repository activity').observed, 1);
  assert.equal(second.review.reviewNumber, 2);
  assert.equal(second.priorReview.observedAt, first.review.observedAt);
  assert.equal((await readThesisJournal('123456789', options)).reviews.length, 3);
});

test('Crypto evidence history is asset-scoped, newest-first, and bounded', () => {
  const journal = { reviews: [
    { assetId: 'ethereum', observedAt: '2026-01-01T00:00:00Z', reviewNumber: 1 },
    { assetId: 'bitcoin', observedAt: '2026-03-01T00:00:00Z' },
    { assetId: 'ETHEREUM', observedAt: '2026-02-01T00:00:00Z', reviewNumber: 2 },
    { assetId: 'ethereum', observedAt: '2026-03-01T00:00:00Z', reviewNumber: 3 },
    { assetId: 'ethereum', observedAt: '2026-04-01T00:00:00Z', reviewNumber: 4 }
  ] };
  assert.deepEqual(recentThesisEvidenceReviews(journal, 'ETHEREUM', 2).map((row) => row.reviewNumber), [4, 3]);
  assert.equal(recentThesisEvidenceReviews(journal, 'ethereum', 100).length, 3);
});

test('Crypto evidence coverage uses latest capture and distinguishes unavailable fields from observed values', () => {
  const journal = { reviews: [
    { assetId: 'ethereum', observedAt: '2026-01-01T00:00:00Z', facts: [{ key: 'price_usd', value: 100 }] },
    { assetId: 'ethereum', observedAt: '2026-02-01T00:00:00Z', source: 'CoinGecko', providerAsOf: '2026-02-01T00:00:00Z', facts: [
      { key: 'price_usd', value: 0, periodEnd: '2026-02-01T00:00:00Z', factSource: 'CoinGecko' }, { key: 'market_cap_usd', value: null }, { key: 'circulating_supply', value: 1000, periodEnd: '2026-01-20', factSource: 'CoinGecko' }
    ] }
  ] };
  const coverage = thesisEvidenceCoverage(journal, 'ETHEREUM');
  assert.equal(coverage.review.observedAt, '2026-02-01T00:00:00Z');
  assert.equal(coverage.fieldsObserved, 2);
  assert.equal(coverage.domains[0].status, 'partial');
  assert.equal(coverage.domains[0].latestPeriodEnd, '2026-02-01T00:00:00Z');
  assert.equal(coverage.domains[0].periodAgeDays, 0);
  assert.equal(coverage.domains[0].periodRelation, 'before_capture');
  assert.deepEqual(coverage.domains[0].sources, ['CoinGecko']);
  assert.equal(coverage.domains[1].status, 'partial');
  assert.equal(coverage.domains[1].latestPeriodEnd, '2026-01-20');
  assert.equal(coverage.domains[1].periodAgeDays, 12);
  assert.equal(coverage.domains[2].status, 'not observed');
  assert.equal(coverage.domains[3].status, 'not observed');
  assert.equal(coverage.domains[3].latestPeriodEnd, '');
  assert.equal(coverage.domains[3].periodAgeDays, null);
  assert.equal(coverage.domains[4].status, 'not observed');
  assert.equal(coverage.domains[5].status, 'not observed');
  assert.equal(coverage.domains[6].status, 'not observed');
  assert.equal(coverage.protocol, null);
});

test('Crypto evidence coverage flags measurement periods dated after their capture', () => {
  const coverage = thesisEvidenceCoverage({ reviews: [{ assetId: 'ethereum', observedAt: '2026-02-01T00:00:00Z', facts: [
    { key: 'price_usd', value: 100, periodEnd: '2026-02-05T00:00:00Z' }
  ] }] }, 'ethereum');
  assert.equal(coverage.domains[0].latestPeriodEnd, '2026-02-05T00:00:00Z');
  assert.equal(coverage.domains[0].periodAgeDays, 4);
  assert.equal(coverage.domains[0].periodRelation, 'after_capture');
});

test('Crypto evidence fact sources identify market and paid/free protocol endpoints', () => {
  assert.equal(cryptoEvidenceFactSource({ key: 'price_usd' }, 'CoinGecko'), 'CoinGecko');
  assert.equal(cryptoEvidenceFactSource({ key: 'protocol_tvl_usd' }), 'DeFiLlama public protocol TVL history');
  assert.equal(cryptoEvidenceFactSource({ key: 'protocol_gross_revenue_usd' }), 'DeFiLlama Pro protocol financial-statement endpoint');
  assert.equal(cryptoEvidenceFactSource({ key: 'protocol_active_users_30d' }), 'DeFiLlama Pro protocol activity endpoint');
  assert.equal(cryptoEvidenceFactSource({ key: 'protocol_max_supply' }), 'DeFiLlama Pro emission endpoint');
  assert.equal(cryptoEvidenceFactSource({ key: 'unknown', factSource: 'manual source' }), 'manual source');
});

test('Crypto evidence coverage exposes stored protocol provider statuses and classifies captured protocol domains', () => {
  const coverage = thesisEvidenceCoverage({ reviews: [{ assetId: 'ethereum', observedAt: '2026-09-27T10:00:00Z', facts: [
    { key: 'protocol_tvl_usd', value: 250, factSource: 'DeFiLlama public protocol TVL history' }, { key: 'protocol_gross_revenue_usd', value: 9 }, { key: 'protocol_max_supply', value: 1000 },
    { key: 'protocol_active_users_24h', value: 10 }, { key: 'protocol_transactions_24h', value: 100 }
  ], protocolSummary: { slug: 'aave', tvlStatus: 'available; latest point 1d old', financialStatus: 'available', usageStatus: 'available; 2 reported fields', emissions: { available: true, note: '1 upcoming event' } } }] }, 'ethereum');
  assert.equal(coverage.protocol.slug, 'aave');
  assert.equal(coverage.protocol.tvlStatus, 'available; latest point 1d old');
  assert.equal(coverage.protocol.financialStatus, 'available');
  assert.equal(coverage.protocol.usageStatus, 'available; 2 reported fields');
  assert.deepEqual(coverage.domains[3].sources, ['DeFiLlama public protocol TVL history']);
  assert.equal(coverage.domains.find((row) => row.label === 'Protocol users and transactions').observed, 2);
  assert.equal(coverage.domains[3].status, 'partial');
  assert.equal(coverage.domains[4].status, 'partial');
  assert.equal(coverage.domains[5].status, 'partial');
});

test('protocol activity comparison requires a newer capture, the same exact slug, key and unit', () => {
  const prior = { observedAt: '2026-09-25T12:00:00Z', protocolSummary: { slug: 'aave' }, facts: [
    { key: 'protocol_active_users_24h', label: 'Active users (24h)', value: 100, unit: 'users' },
    { key: 'protocol_transactions_30d', label: 'Transactions (30d)', value: 1000, unit: 'transactions' },
    { key: 'protocol_active_users_30d', label: 'Active users (30d)', value: 400, unit: 'users' },
    { key: 'protocol_transactions_7d', label: 'Transactions (7d)', value: 0, unit: 'transactions' }
  ] };
  const current = { observedAt: '2026-09-26T12:00:00Z', protocolSummary: { slug: 'aave' }, facts: [
    { key: 'protocol_active_users_24h', label: 'Active users (24h)', value: 125, unit: 'users' },
    { key: 'protocol_transactions_30d', label: 'Transactions (30d)', value: 900, unit: 'transactions' },
    { key: 'protocol_transactions_7d', label: 'Transactions (7d)', value: 25, unit: 'transactions' },
    { key: 'protocol_active_users_30d', label: 'Active users (30d)', value: 500, unit: 'accounts' }
  ] };
  assert.deepEqual(compareProtocolActivityCaptures(current, prior).map((row) => [row.key, Math.round(row.changePct * 10) / 10]), [
    ['protocol_active_users_24h', 25], ['protocol_transactions_30d', -10]
  ]);
  assert.deepEqual(compareProtocolActivityCaptures({ ...current, protocolSummary: { slug: 'aave-v3' } }, prior), []);
  assert.deepEqual(compareProtocolActivityCaptures({ ...current, observedAt: prior.observedAt }, prior), []);
});

test('protocol activity history uses only matching dated slug, asset, metric and unit captures', () => {
  const review = (observedAt, assetId, slug, facts) => ({ observedAt, assetId, protocolSummary: { slug }, facts });
  const history = [
    review('2026-09-25T12:00:00Z', 'ethereum', 'aave', [
      { key: 'protocol_active_users_24h', label: 'Active users (24h)', value: 100, unit: 'users' },
      { key: 'protocol_transactions_30d', label: 'Transactions (30d)', value: 0, unit: 'transactions' }
    ]),
    review('2026-09-26T12:00:00Z', 'ethereum', 'AAVE', [
      { key: 'protocol_active_users_24h', label: 'Active users (24h)', value: 110, unit: 'users' },
      { key: 'protocol_transactions_30d', label: 'Transactions (30d)', value: 0, unit: 'transactions' },
      { key: 'protocol_active_users_30d', label: 'Active users (30d)', value: 900, unit: 'users' }
    ]),
    review('2026-09-27T12:00:00Z', 'other-asset', 'aave', [
      { key: 'protocol_active_users_24h', label: 'Active users (24h)', value: 500, unit: 'users' }
    ]),
    review('2026-09-29T12:00:00Z', 'ethereum', 'aave', [
      { key: 'protocol_active_users_24h', label: 'Active users (24h)', value: 999, unit: 'users' }
    ])
  ];
  const current = review('2026-09-28T12:00:00Z', 'ethereum', 'aave', [
    { key: 'protocol_active_users_24h', label: 'Active users (24h)', value: 105, unit: 'users' },
    { key: 'protocol_transactions_30d', label: 'Transactions (30d)', value: 50, unit: 'transactions' },
    { key: 'protocol_active_users_30d', label: 'Active users (30d)', value: 1000, unit: 'accounts' }
  ]);
  const result = summarizeProtocolActivityHistory(history, current);
  assert.deepEqual(result.map((row) => row.key), ['protocol_active_users_24h', 'protocol_transactions_30d']);
  assert.equal(result[0].sampleCount, 3);
  assert.equal(result[0].firstValue, 100);
  assert.equal(result[0].latestValue, 105);
  assert.equal(result[0].risingSteps, 1);
  assert.equal(result[0].fallingSteps, 1);
  assert.ok(Math.abs(result[0].changePct - 5) < 1e-9);
  assert.equal(result[1].changePct, null, 'zero baseline remains an unavailable percentage');
  assert.equal(result[1].risingSteps, 1);
  assert.deepEqual(summarizeProtocolActivityHistory(history, { ...current, protocolSummary: { slug: 'aave-v3' } }), []);
  assert.deepEqual(summarizeProtocolActivityHistory(history, { ...current, assetId: '' }), []);
});

test('Crypto thesis review prompts test network usage and token value capture separately', () => {
  const networkPrompts = thesisReviewPrompts({ thesisType: 'network_adoption' });
  const tokenPrompts = thesisReviewPrompts({ thesisType: 'token_value_capture' });
  assert.equal(networkPrompts.length, 3);
  assert.match(networkPrompts[0], /incentive-driven/i);
  assert.match(tokenPrompts[0], /links protocol use to demand/i);
  assert.match(thesisReviewPrompts({ thesisType: 'unclassified' })[0], /observed fact/i);
});

test('Crypto personal assessments are append-only and follow the exact asset thesis revisions', async () => {
  const storage = memory(), options = { storage, file: 'crypto-assessments', now: '2026-09-25T12:00:00Z' };
  await appendThesisRevision('123456789', input({ assetId: 'ethereum' }), options);
  const first = await appendThesisAssessment('123456789', { assetId: 'ETHEREUM', status: 'thesis_intact', notes: 'Usage is rising, but value capture still needs verification.' }, options);
  await appendThesisRevision('123456789', input({ assetId: 'ethereum', thesis: 'Updated after governance review.' }), options);
  const second = await appendThesisAssessment('123456789', { assetId: 'ethereum', status: 'insufficient_evidence', notes: 'No on-chain history has been collected yet.' }, options);
  const saved = await readThesisJournal('123456789', options);
  assert.equal(first.entry.assetId, 'ethereum');
  assert.equal(first.entry.thesisRevision, 1);
  assert.equal(second.entry.thesisRevision, 2);
  assert.equal(saved.assessments.length, 2);
  assert.deepEqual(recentThesisAssessments(saved, 'ETHEREUM', 2).map((row) => row.status), ['insufficient_evidence', 'thesis_intact']);
  await assert.rejects(appendThesisAssessment('123456789', { assetId: 'ethereum', status: 'buy', notes: 'Unsupported category.' }, options), /assessment/);
});

test('Crypto thesis performance snapshots only compare the same exchange pair context', async () => {
  const storage = memory(), options = { storage, file: 'crypto-performance' };
  await appendThesisRevision('123456789', input({ assetId: 'ethereum', horizonMonths: 12 }), options);
  await appendThesisPerformanceSnapshot('123456789', { assetId: 'ethereum', source: 'Binance daily exchange candles',
    marketKey: 'Binance|ETHUSDT|BTCUSDT', benchmarkSymbol: 'BTC', asOf: '2026-01-01', observedAt: '2026-01-02T00:00:00Z', assetPrice: 3000, benchmarkPrice: 90000 }, options);
  await appendThesisPerformanceSnapshot('123456789', { assetId: 'ethereum', source: 'Binance daily exchange candles',
    marketKey: 'Binance|ETHUSDT|BTCUSDT', benchmarkSymbol: 'BTC', asOf: '2026-02-01', observedAt: '2026-02-02T00:00:00Z', assetPrice: 3300, benchmarkPrice: 99000 }, options);
  await appendThesisPerformanceSnapshot('123456789', { assetId: 'ethereum', source: 'Binance daily exchange candles',
    marketKey: 'Binance|ETHUSDT|BTCUSDT', benchmarkSymbol: 'BTC', asOf: '2026-01-15', observedAt: '2026-01-16T00:00:00Z', assetPrice: 2400, benchmarkPrice: 81000 }, options);
  const sameVenue = summarizeThesisPerformance(await readThesisJournal('123456789', options), 'ethereum');
  assert.ok(Math.abs(sameVenue.assetObservedMaxDrawdownPct - (-20)) < 1e-9);
  assert.ok(Math.abs(sameVenue.benchmarkObservedMaxDrawdownPct - (-10)) < 1e-9);
  await appendThesisPerformanceSnapshot('123456789', { assetId: 'ethereum', source: 'Coinbase daily exchange candles',
    marketKey: 'Coinbase|ETH-USD|BTC-USD', benchmarkSymbol: 'BTC', asOf: '2026-03-01', observedAt: '2026-03-02T00:00:00Z', assetPrice: 3600, benchmarkPrice: 108000 }, options);
  const summary = summarizeThesisPerformance(await readThesisJournal('123456789', options), 'ethereum');
  assert.equal(summary.assetReturnPct, 0);
  assert.equal(summary.benchmarkReturnPct, 0);
  assert.equal(summary.providerChanged, true);
  assert.equal(summary.comparableSnapshots, 1);
  assert.equal(summary.assetObservedMaxDrawdownPct, null);
});

test('Crypto thesis command is available with add, list, and latest-thesis actions', () => {
  const command = buildCommands().find((row) => row.name === 'crypto');
  const thesis = command.options.find((row) => row.name === 'thesis');
  assert.ok(thesis);
  assert.deepEqual(thesis.options.find((row) => row.name === 'action').choices.map((row) => row.value), ['add', 'list', 'show', 'due', 'review', 'history', 'coverage', 'performance', 'assess']);
  assert.ok(thesis.options.some((row) => row.name === 'assessment'));
  assert.ok(thesis.options.some((row) => row.name === 'assessment_notes'));
  assert.ok(thesis.options.some((row) => row.name === 'thesis_type'));
  assert.ok(thesis.options.some((row) => row.name === 'review_date'));
  assert.ok(thesis.options.some((row) => row.name === 'github_repo'));
  assert.ok(thesis.options.length <= 25);
});
