import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { runIndependentOptionPaper, buildIndependentOptionCandidate } from '../src/independentPaperResearch.js';
import { evaluateUnderlyingResearch } from '../src/underlyingResearchStrategy.js';
import { UNDERLYING_RESEARCH_VERSION, UNDERLYING_RESEARCH_HASH, UNDERLYING_RESEARCH_RULES } from '../src/underlyingResearchStrategy.js';
import { archiveDiscovery } from '../../shared/equitySnapshotDiscovery.js';
import { researchInput, NOW } from './underlyingResearchFixtures.js';

const config = { maxQuoteAgeMs: 10000, maxLegSkewMs: 3000, minOpenInterest: 100, minVolume: 1, maxLegSpreadPct: 15,
  minDaysToExpiry: 1, maxDaysToExpiry: 45, minRewardRisk: 1.5, feePerContractRoundTrip: 0.65, slippageReservePerContract: 0.25 };
const policy = { emergencyStop: false, liveTradingEnabled: false, maxSpreadPct: 25, maxTradeRiskPct: 0.25,
  maxTotalOpenRiskPct: 1, maxGrossExposurePct: 100, maxDailyLossPct: 1, minRewardRisk: 1.5, maxOpenMarkAgeMs: 300000 };
const eventReviews = () => ({ reviews: [{ symbol: 'FRESH', status: 'clear', source: 'manual-review', summary: 'Synthetic event review only.', reviewedAt: new Date(NOW).toISOString() }],
  assignmentReviews: [{ symbol: 'FRESH', status: 'clear', source: 'https://issuer.example/dividends', summary: 'Synthetic dividend review only.',
    reviewedAt: new Date(NOW).toISOString(), reviewedThrough: '2026-10-09', nextExDividendDate: null }] });

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-independent-option-paper-'));
  t.after(async () => { const rel = relative(tmpdir(), directory); assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..')); await rm(directory, { recursive: true, force: true }); });
  const portfolio = join(directory, 'production.json');
  await writeFile(portfolio, JSON.stringify({ schemaVersion: 1, orders: [], events: [] }));
  let time = NOW, exit = false;
  const calls = [], metrics = [], observation = evaluateUnderlyingResearch(researchInput());
  assert.equal(observation.status, 'technical_watch');
  const intraday = { diagnostics: { feed: 'iex' }, rows: [observation] };
  const archivePath = join(directory, 'underlying-archive');
  intraday.diagnostics.archive = await archiveDiscovery({ owner: 'options', version: UNDERLYING_RESEARCH_VERSION,
    configHash: UNDERLYING_RESEARCH_HASH, rules: UNDERLYING_RESEARCH_RULES, feed: 'iex', rows: [observation],
    barsBySymbol: { FRESH: researchInput().bars }, quotesBySymbol: { FRESH: researchInput().quote } }, { directory: archivePath, now: NOW });
  const pacer = async () => ({ localQueueDelayMs: 0 }); pacer.deferStarts = () => {};
  const rawLegs = () => [
    { symbol: 'FRESH261009C00100000', underlying: 'FRESH', root_symbol: 'FRESH', expiration_date: '2026-10-09', option_type: 'call', strike: 100,
      contract_size: 100, bid: exit ? 1.38 : 1, ask: exit ? 1.4 : 1.02, bid_date: time, ask_date: time, volume: 100, open_interest: 1000 },
    { symbol: 'FRESH261009C00101000', underlying: 'FRESH', root_symbol: 'FRESH', expiration_date: '2026-10-09', option_type: 'call', strike: 101,
      contract_size: 100, bid: 0.7, ask: 0.72, bid_date: time, ask_date: time, volume: 100, open_interest: 1000 },
  ];
  const fetcher = async (target, init = {}) => {
    const url = new URL(target); calls.push(url); assert.equal(init.method || 'GET', 'GET'); assert.doesNotMatch(url.pathname, /orders/);
    time += options.requestDelayMs || 0;
    let payload;
    if (url.pathname.endsWith('/clock')) payload = { clock: { state: 'open', timestamp: new Date(time).toISOString(), next_change: '2026-10-02T20:00:00Z' } };
    else if (url.pathname.endsWith('/quotes')) payload = { quotes: { quote: url.searchParams.get('symbols').split(',').map(symbol => symbol === 'FRESH'
      ? { symbol: 'FRESH', bid: 100.39, ask: 100.41, bid_date: time, ask_date: time } : rawLegs().find(leg => leg.symbol === symbol)) } };
    else if (url.pathname.endsWith('/expirations')) payload = { expirations: { date: ['2026-10-09'] } };
    else if (url.pathname.endsWith('/chains')) payload = { options: { option: rawLegs() } };
    else throw new Error('Unexpected fixture endpoint');
    if (options.mutate) payload = options.mutate(payload, url, time);
    return { ok: true, status: 200, headers: new Headers({ 'X-Ratelimit-Available': String(options.remainingQuota ?? 100) }), json: async () => payload };
  };
  const reviewPath = join(directory, 'current-reviews.json');
  await writeFile(reviewPath, JSON.stringify(eventReviews()));
  const env = { TRADIER_TOKEN: 'fixture-token', TRADIER_ENV: 'production', OPTIONS_CATALYST_SOURCE: 'manual', OPTIONS_CATALYST_REVIEW_FILE: reviewPath,
    OPTIONS_INTRADAY_RESEARCH_HISTORY_PATH: archivePath, ...options.env };
  return { directory, portfolio, reviewPath, intraday, calls, metrics, observation, advance: (ms) => { time += ms; }, exit: () => { exit = true; },
    run: (extra = {}) => runIndependentOptionPaper({ intradayResearch: intraday, reviews: eventReviews(), strategyConfig: config,
      riskPolicy: policy, accountEquity: 50000, portfolioStatePath: portfolio, stateDirectory: join(directory, 'shadow'),
      env, now: time, clock: () => time, fetcher, providerMetrics: metrics, startPacer: pacer, ...extra }) };
}

test('independent experiment freezes before later reservation, fills later, and closes after costs without production writes', async (t) => {
  const f = await fixture(t), before = await readFile(f.portfolio, 'utf8');
  const frozen = await f.run();
  assert.equal(frozen.diagnostics.strategyCandidates, 1, JSON.stringify(frozen.evaluations));
  assert.equal(frozen.diagnostics.shadowReservations, 0);
  assert.equal(frozen.forward[0].manifest.status, 'frozen_new');
  assert.ok(frozen.forward[0].decisions[0].reasons.includes('forward_window_starts_after_manifest_freeze'));
  assert.equal(frozen.evaluations[0].candidate.roundTripFeesPerUnit, 1.3);
  assert.equal(frozen.evaluations[0].candidate.slippageReservePerUnit, 0.5);
  assert.equal(frozen.evaluations[0].candidate.marketGateTrace, null);
  f.advance(1000);
  const reserved = await f.run();
  assert.equal(reserved.diagnostics.shadowReservations, 1, JSON.stringify(reserved.forward[0].decisions));
  let ledger = JSON.parse(await readFile(reserved.forward[0].statePath));
  assert.equal(ledger.orders[0].status, 'reserved');
  assert.match(ledger.orders[0].strategyId, /^independent-orb-debit-vertical-v3:shadow:/);
  assert.equal(ledger.orders[0].approvalEvidence.marketGateTrace.status, 'unavailable');
  f.advance(1000);
  const filled = await f.run({ reviews: { reviews: [], assignmentReviews: [] }, intradayResearch: { diagnostics: { feed: 'iex' }, rows: [] } });
  ledger = JSON.parse(await readFile(reserved.forward[0].statePath));
  assert.equal(ledger.orders[0].status, 'filled');
  assert.equal(filled.forward[0].performance.sampleSize, 0);
  f.advance(1000); f.exit();
  const closed = await f.run({ intradayResearch: { diagnostics: { feed: 'iex' }, rows: [] } });
  ledger = JSON.parse(await readFile(reserved.forward[0].statePath));
  const order = ledger.orders[0];
  assert.equal(order.status, 'closed');
  assert.equal(order.exitReason, 'target');
  assert.ok(order.feesUsd > 0 && order.slippageUsd > 0);
  assert.ok(Math.abs(order.realizedPnlUsd - (order.grossPnlUsd - order.feesUsd - order.slippageUsd)) < 0.001);
  assert.equal(closed.forward[0].performance.sampleSize, 1);
  assert.equal(closed.forward[0].performance.recentSessionExpectancyBootstrap.lower95R, null);
  assert.equal(await readFile(f.portfolio, 'utf8'), before);
  const journal = (await readFile(join(f.directory, 'shadow/options-independent/observations-2026-10-02.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(journal.length, 4);
  assert.equal(journal[0].inputs[0].chain.options.length, 2);
  assert.equal(journal[0].diagnostics.publishedAsApproved, false);
  assert.ok(!JSON.stringify(journal).includes('fixture-token'));
});

test('unchanged repeated scans cannot create duplicate isolated reservations', async (t) => {
  const f = await fixture(t); await f.run(); f.advance(1000);
  const reserved = await f.run(); assert.equal(reserved.diagnostics.shadowReservations, 1);
  const repeated = await f.run();
  assert.equal(repeated.diagnostics.shadowReservations, 0);
  const ledger = JSON.parse(await readFile(reserved.forward[0].statePath));
  assert.equal(ledger.orders.length, 1);
});

test('missing costs, catalysts, call-assignment review and identity remain separate rejection gates', async (t) => {
  const f = await fixture(t);
  const costs = await f.run({ strategyConfig: { ...config, feePerContractRoundTrip: NaN } });
  assert.equal(costs.diagnostics.status, 'execution_costs_unconfigured');
  assert.equal(f.calls.length, 0);
  const catalyst = await f.run({ reviews: {} });
  assert.equal(catalyst.diagnostics.providerReady, 0);
  assert.equal(catalyst.diagnostics.rejectionReasons.catalyst_review_required, 1);
  assert.equal(catalyst.forward[0].manifest.status, 'waiting_for_inputs');
  const assignment = await f.run({ reviews: { reviews: eventReviews().reviews, assignmentReviews: [] } });
  assert.equal(assignment.diagnostics.rejectionReasons.call_assignment_review_missing_stale_or_incomplete, 1);
  assert.equal(assignment.forward[0].manifest.status, 'waiting_for_inputs');
  const wrong = await fixture(t, { mutate: (body, url) => {
    if (url.pathname.endsWith('/chains')) body.options.option.forEach((row) => { row.underlying = 'WRONG'; }); return body;
  } });
  const identity = await wrong.run();
  assert.equal(identity.diagnostics.rejectionReasons.no_verified_contract_quotes, 1);
  assert.equal(identity.diagnostics.shadowReservations, 0);
});

test('risk stop and shared underlying exposure cannot be bypassed by independent research', async (t) => {
  const f = await fixture(t);
  const stopped = await f.run({ riskPolicy: { ...policy, emergencyStop: true } });
  assert.equal(stopped.diagnostics.shadowReservations, 0);
  assert.equal(stopped.forward[0].manifest.status, 'waiting_for_inputs');
  await f.run(); f.advance(1000);
  await writeFile(f.portfolio, JSON.stringify({ schemaVersion: 1, events: [], orders: [{ orderId: 'stock', owner: 'stocks', assetClass: 'stock',
    instrumentKey: 'FRESH', exposureKey: 'FRESH', direction: 'long', idempotencyKey: 'separate-stock', status: 'reserved',
    riskUsd: 20, notionalUsd: 100, marginRequirementUsd: 0, sessionDate: '2026-10-02' }] }));
  const blocked = await f.run();
  assert.equal(blocked.diagnostics.shadowReservations, 0);
  assert.ok(blocked.forward[0].decisions[0].reasons.includes('duplicate_open_exposure'));
});

test('unknown credentials and delayed sandbox never become executable forward observations', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run({ env: {} })).diagnostics.status, 'credentials_missing');
  assert.equal((await f.run({ env: { TRADIER_TOKEN: 'fixture-token' } })).diagnostics.status, 'sandbox_quotes_not_executable');
  assert.equal((await f.run({ env: { OPTIONS_INDEPENDENT_PAPER_SOURCE: 'disabled' } })).diagnostics.status, 'disabled');
  assert.equal(f.calls.length, 0);
  assert.deepEqual((await readdir(f.directory)).sort(), ['current-reviews.json', 'production.json', 'underlying-archive']);
});

test('independent forward research preserves raw underlying inputs and refuses an unmatched source archive', async (t) => {
  const f = await fixture(t);
  const good = await f.run();
  assert.equal(good.diagnostics.underlyingInputs.status, 'preserved');
  assert.ok((await readFile(join(f.directory, 'shadow/options-independent', good.diagnostics.underlyingInputs.file))).length > 0);
  const tampered = structuredClone(f.intraday); tampered.rows[0].referenceLevels.target += 1;
  const bad = await f.run({ intradayResearch: tampered });
  assert.equal(bad.diagnostics.failure.reason, 'underlying_archive_observation_mismatch');
  assert.equal(bad.diagnostics.shadowReservations, 0);
});

test('reference target is fixed and stale, drifted, conflicted or delayed observations cannot approve a spread', async (t) => {
  const f = await fixture(t), run = await f.run();
  const input = run.inputs[0];
  const check = (observation, providerInput = input, time = NOW) => buildIndependentOptionCandidate({ observation, input: providerInput, now: time, config });
  assert.equal(check(f.observation).status, 'candidate');
  assert.equal(check({ ...f.observation, status: 'withheld_for_conflict' }).reasons[0], 'independent_hypothesis_or_identity_unverified');
  assert.equal(check(f.observation, input, NOW + 120001).reasons[0], 'independent_observation_expired');
  assert.equal(check(f.observation, { ...input, marketDataStatus: 'sandbox_data_is_delayed' }).status, 'provider_or_input_rejected');
  const moved = { ...input, signal: { ...input.signal, underlyingQuote: { ...input.signal.underlyingQuote, bid: 102, ask: 102.01 } } };
  assert.equal(check(f.observation, moved).reasons[0], 'independent_quote_not_current_or_near_reference');
  assert.equal(input.signal.underlyingTarget, f.observation.referenceLevels.target);
});

test('configured company-news failure prevents option-chain reads rather than treating missing news as clearance', async (t) => {
  const f = await fixture(t, { env: { OPTIONS_CATALYST_SOURCE: 'alpaca' } });
  const result = await f.run();
  assert.equal(result.diagnostics.shadowReservations, 0);
  assert.equal(f.calls.some((url) => url.pathname.endsWith('/chains')), false);
});

test('stale later option marks leave a filled position unresolved until executable quotes return', async (t) => {
  let stale = false;
  const f = await fixture(t, { mutate: (body, url, time) => {
    if (stale && url.pathname.endsWith('/quotes') && Array.isArray(body.quotes.quote)) {
      body.quotes.quote.forEach((row) => { row.bid_date = row.ask_date = time - 60000; });
    }
    return body;
  } });
  await f.run(); f.advance(1000);
  const reserved = await f.run(); f.advance(1000);
  const monitor = { intradayResearch: { diagnostics: { feed: 'iex' }, rows: [] } };
  await f.run(monitor); f.advance(1000); f.exit(); stale = true;
  const unavailable = await f.run(monitor);
  assert.equal(unavailable.diagnostics.positionMarks.rejectionReasons.stale_or_future_option_leg_quote, 1);
  let ledger = JSON.parse(await readFile(reserved.forward[0].statePath));
  assert.equal(ledger.orders[0].status, 'filled');
  assert.equal(unavailable.forward[0].performance.sampleSize, 0);
  stale = false; f.advance(1000);
  await f.run(monitor);
  ledger = JSON.parse(await readFile(reserved.forward[0].statePath));
  assert.equal(ledger.orders[0].status, 'closed');
});

test('quota headroom and elapsed request budget stop extra requests without freezing an experiment', async (t) => {
  const quota = await fixture(t, { remainingQuota: 5 });
  const limited = await quota.run();
  assert.equal(quota.calls.length, 1);
  assert.equal(limited.diagnostics.strategyCandidates, 0);
  assert.equal(limited.forward[0].manifest.status, 'waiting_for_inputs');
  const deadline = await fixture(t, { requestDelayMs: 1500, env: { OPTIONS_INDEPENDENT_PAPER_BUDGET_MS: '1000' } });
  const timedOut = await deadline.run();
  assert.equal(deadline.calls.length, 1);
  assert.equal(timedOut.diagnostics.strategyCandidates, 0);
  assert.equal(timedOut.forward[0].manifest.status, 'waiting_for_inputs');
});

test('marks received after slow provider calls use the advanced observation time', async (t) => {
  const f = await fixture(t, { requestDelayMs: 2000 });
  const frozen = await f.run();
  assert.equal(frozen.forward[0].manifest.status, 'frozen_new');
  f.advance(1000);
  const reserved = await f.run();
  assert.equal(reserved.diagnostics.shadowReservations, 1, JSON.stringify(reserved.forward[0].decisions));
  f.advance(1000);
  const marked = await f.run({ intradayResearch: { diagnostics: { feed: 'iex' }, rows: [] } });
  assert.equal(marked.diagnostics.positionMarks.quoted, 1);
  const ledger = JSON.parse(await readFile(reserved.forward[0].statePath));
  assert.equal(ledger.orders[0].status, 'filled');
  assert.ok(Date.parse(ledger.orders[0].filledAt) > Date.parse(ledger.orders[0].reservedAt));
});

test('independent pending spread uses later underlying quotes and cancels a missed move without a fill', async t => {
  let moved = false;
  const f = await fixture(t, { mutate: (body, url) => {
    if (moved && url.pathname.endsWith('/quotes')) for (const row of [body.quotes.quote].flat()) {
      if (row.symbol === 'FRESH') { row.bid = 103; row.ask = 103.02; }
    }
    return body;
  } });
  await f.run(); f.advance(1000);
  const reserved = await f.run(); f.advance(1000); moved = true;
  const monitored = await f.run({ intradayResearch: { diagnostics: { feed: 'iex' }, rows: [] } });
  const ledger = JSON.parse(await readFile(reserved.forward[0].statePath));
  assert.equal(ledger.orders[0].status, 'cancelled');
  assert.equal(ledger.orders[0].cancelReason, 'option_underlying_target_passed_before_fill');
  assert.equal(ledger.orders[0].filledAt, undefined);
  assert.equal(monitored.diagnostics.positionMarks.pendingEntryRejections.option_underlying_target_passed_before_fill, 1);
});

test('independent pending entries reread a revoked manual review even without a new discovery shortlist', async t => {
  const f = await fixture(t); await f.run(); f.advance(1000);
  const reserved = await f.run(); f.advance(1000);
  const reviews = eventReviews(); reviews.reviews[0].status = 'blocked';
  await writeFile(f.reviewPath, JSON.stringify(reviews));
  const monitored = await f.run({ intradayResearch: { diagnostics: { feed: 'iex' }, rows: [] } });
  const ledger = JSON.parse(await readFile(reserved.forward[0].statePath));
  assert.equal(ledger.orders[0].status, 'reserved');
  assert.equal(monitored.diagnostics.positionMarks.pendingEntryReady, 0);
  assert.equal(monitored.diagnostics.positionMarks.pendingEntryRejections.option_entry_catalyst_clearance_required, 1);
});


test('current observation clock prevents a captured scan time from rejecting a fresh source quote', async (t) => {
  const f = await fixture(t);
  f.advance(1000);
  const result = await f.run({ now: NOW + 999, observationClock: () => NOW + 1000 });
  assert.equal(result.diagnostics.strategyCandidates, 1, JSON.stringify(result.evaluations));
  assert.equal(result.forward[0].manifest.status, 'frozen_new');
  const futureQuote = structuredClone(result.inputs[0]);
  futureQuote.signal.underlyingQuote.time = new Date(NOW + 1001).toISOString();
  assert.equal(buildIndependentOptionCandidate({ observation: f.observation, input: futureQuote, now: NOW + 1000, config }).reasons[0],
    'independent_quote_not_current_or_near_reference');
});

test('invalid observation clocks cannot start independent option research', async (t) => {
  const f = await fixture(t);
  for (const observationClock of [() => NaN, () => NOW - 1, 42]) {
    await assert.rejects(f.run({ observationClock }), /observation clock|observation time/i);
  }
  assert.equal(f.calls.length, 0);
});
