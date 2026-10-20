import path from 'node:path';
import { dataDir } from './config.js';
import { readJson, writeJson } from './storage.js';

const queues = new Map();
const MAX_TEXT = Object.freeze({ thesis: 1200, assumptions: 800, baseCase: 800, bullCase: 800, bearCase: 800, invalidation: 800, catalysts: 600 });
const THESIS_TYPES = new Set(['network_adoption', 'token_value_capture', 'infrastructure', 'defi', 'store_of_value', 'payments', 'speculative_long_duration', 'other']);
const THESIS_ASSESSMENTS = new Set(['thesis_intact', 'mixed', 'weakened', 'invalidation_met', 'insufficient_evidence']);
const PROTOCOL_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

function userFile(userId) {
  const id = String(userId || '');
  if (!/^\d{5,25}$/.test(id)) throw new Error('A valid Discord user id is required.');
  return path.join(dataDir, `investment-thesis-${id}.json`);
}

function validate(input) {
  const assetId = String(input.assetId || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(assetId)) throw new Error('Enter an exact asset id or ticker using letters, numbers, `.`, `_`, `:`, or `-`.');
  const thesisType = String(input.thesisType || '');
  if (!THESIS_TYPES.has(thesisType)) throw new Error('Choose a supported Crypto thesis type.');
  const protocolSlug = String(input.protocolSlug || '').trim().toLowerCase();
  if (protocolSlug && (protocolSlug.length > 64 || !PROTOCOL_SLUG.test(protocolSlug))) throw new Error('Protocol slug must be an exact DeFiLlama slug containing lowercase letters, numbers, and single hyphens.');
  const githubRepo = String(input.githubRepo || '').trim();
  if (githubRepo && (githubRepo.length > 140 || !GITHUB_REPOSITORY.test(githubRepo) || githubRepo.includes('..'))) throw new Error('GitHub repository must be an exact public owner/repo name, not a URL or path.');
  const horizonMonths = Number(input.horizonMonths);
  if (!Number.isInteger(horizonMonths) || horizonMonths < 1 || horizonMonths > 120) throw new Error('Horizon must be between 1 and 120 months.');
  const reviewDate = String(input.reviewDate || '');
  const parsedReview = new Date(`${reviewDate}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewDate) || Number.isNaN(parsedReview.getTime()) || parsedReview.toISOString().slice(0, 10) !== reviewDate)
    throw new Error('Review date must be a real calendar date in YYYY-MM-DD format.');
  const fields = {};
  for (const [key, limit] of Object.entries(MAX_TEXT)) {
    const value = String(input[key] || '').trim();
    if (!value || value.length > limit) throw new Error(`${key} must contain 1–${limit} characters.`);
    fields[key] = value;
  }
  const sources = Array.isArray(input.sources) ? input.sources.map((value) => String(value).trim()).filter(Boolean) : [];
  if (sources.length === 0) throw new Error('Add at least one HTTPS source link to support the thesis.');
  if (sources.length > 5 || sources.some((value) => {
    if (value.length > 500) return true;
    try { const url = new URL(value); return url.protocol !== 'https:' || !url.hostname; }
    catch { return true; }
  }))
    throw new Error('Provide up to five HTTPS source links.');
  return { assetId, thesisType, horizonMonths, reviewDate, protocolSlug, githubRepo, ...fields, sources };
}

function validateEvidenceReview(input) {
  const assetId = String(input.assetId || '').trim().toLowerCase();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(assetId)) throw new Error('Evidence review requires an exact crypto asset id or ticker.');
  const source = String(input.source || '').trim().slice(0, 100);
  const observedAt = new Date(input.observedAt || Date.now()).toISOString();
  const status = ['observed', 'partial', 'coverage_limited', 'unavailable'].includes(input.status) ? input.status : 'observed';
  const facts = (Array.isArray(input.facts) ? input.facts : []).slice(0, 60).map((fact) => ({
    key: String(fact.key || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 48),
    label: String(fact.label || '').slice(0, 80),
    value: fact.value === null || fact.value === undefined || fact.value === '' || !Number.isFinite(Number(fact.value)) ? null : Number(fact.value),
    unit: String(fact.unit || '').slice(0, 24), periodEnd: String(fact.periodEnd || '').slice(0, 32),
    factSource: String(fact.factSource || '').slice(0, 240)
  })).filter((fact) => fact.key && fact.label);
  const protocol = input.protocolSummary && typeof input.protocolSummary === 'object' ? input.protocolSummary : null;
  const allocationMap = (value) => Object.fromEntries(Object.entries(value || {}).filter(([, amount]) => amount !== null && Number.isFinite(Number(amount))).slice(0, 8).map(([key, amount]) => [String(key).slice(0, 48), Number(amount)]));
  const protocolSummary = protocol ? {
    slug: String(protocol.slug || '').replace(/[^a-z0-9-]/g, '').slice(0, 64),
    tvlStatus: String(protocol.tvlStatus || '').slice(0, 120),
    financialStatus: String(protocol.financialStatus || '').slice(0, 120),
    usageStatus: String(protocol.usageStatus || '').slice(0, 120),
    emissions: protocol.emissions && typeof protocol.emissions === 'object' ? {
      available: Boolean(protocol.emissions.available), name: String(protocol.emissions.name || '').slice(0, 80),
      lastModified: String(protocol.emissions.lastModified || '').slice(0, 40), note: String(protocol.emissions.note || '').slice(0, 160),
      eventCount: protocol.emissions.eventCount === null || protocol.emissions.eventCount === undefined ? null : Number.isFinite(Number(protocol.emissions.eventCount)) ? Number(protocol.emissions.eventCount) : null,
      upcomingEvents: (Array.isArray(protocol.emissions.upcomingEvents) ? protocol.emissions.upcomingEvents : []).slice(0, 3).map((event) => ({
        date: String(event.date || '').slice(0, 32), category: String(event.category || '').slice(0, 48), unlockType: String(event.unlockType || '').slice(0, 32),
        description: String(event.description || '').replace(/[\r\n]+/g, ' ').slice(0, 100),
        tokenAmount: event.tokenAmount === null || event.tokenAmount === undefined || !Number.isFinite(Number(event.tokenAmount)) ? null : Number(event.tokenAmount)
      }))
    } : null,
    allocation: protocol.allocation && typeof protocol.allocation === 'object' ? { current: allocationMap(protocol.allocation.current), final: allocationMap(protocol.allocation.final) } : null
    ,security: protocol.security && typeof protocol.security === 'object' ? {
      status: String(protocol.security.status || '').slice(0, 48), protocolId: String(protocol.security.protocolId || '').slice(0, 120),
      observedAt: String(protocol.security.observedAt || '').slice(0, 32), incidentCount: protocol.security.incidentCount === null || protocol.security.incidentCount === undefined || !Number.isFinite(Number(protocol.security.incidentCount)) ? null : Number(protocol.security.incidentCount),
      events: (Array.isArray(protocol.security.events) ? protocol.security.events : []).slice(0, 5).map((event) => ({
        date: String(event.date || '').slice(0, 32), classification: String(event.classification || '').slice(0, 48), technique: String(event.technique || '').slice(0, 80),
        amountUsd: event.amountUsd === null || event.amountUsd === undefined || !Number.isFinite(Number(event.amountUsd)) ? null : Number(event.amountUsd),
        chains: (Array.isArray(event.chains) ? event.chains : []).slice(0, 5).map((chain) => String(chain).slice(0, 32)), bridgeHack: Boolean(event.bridgeHack), source: /^https:\/\//i.test(String(event.source || '')) ? String(event.source).slice(0, 240) : ''
      }))
    } : null
  } : null;
  const github = input.githubSummary && typeof input.githubSummary === 'object' ? input.githubSummary : null;
  const githubNumber = (value) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  const githubSummary = github ? {
    repository: String(github.repository || '').slice(0, 140), status: String(github.status || '').slice(0, 40),
    observedAt: String(github.observedAt || '').slice(0, 32), from: String(github.from || '').slice(0, 32), recentFrom: String(github.recentFrom || '').slice(0, 32),
    pages: Number.isInteger(githubNumber(github.pages)) ? githubNumber(github.pages) : null, truncated: Boolean(github.truncated),
    recentCommits: githubNumber(github.recentCommits), priorCommits: githubNumber(github.priorCommits),
    recentContributors: githubNumber(github.recentContributors), priorContributors: githubNumber(github.priorContributors),
    httpStatus: Number.isInteger(githubNumber(github.httpStatus)) ? githubNumber(github.httpStatus) : null
  } : null;
  return Object.freeze({ assetId, source: source || 'Market data snapshot', status, observedAt,
    providerAsOf: String(input.providerAsOf || '').slice(0, 32), note: String(input.note || '').slice(0, 240), facts, protocolSummary, githubSummary });
}

export async function readThesisJournal(userId, options = {}) {
  const storage = options.storage || { readJson };
  const saved = await storage.readJson(options.file || userFile(userId), { version: 1, userId: String(userId), revisions: [], assessments: [] });
  if (saved?.version !== 1 || saved.userId !== String(userId) || !Array.isArray(saved.revisions)
    || (saved.reviews !== undefined && !Array.isArray(saved.reviews))
    || (saved.assessments !== undefined && !Array.isArray(saved.assessments))
    || (saved.performanceSnapshots !== undefined && !Array.isArray(saved.performanceSnapshots)))
    throw new Error('Investment thesis journal has invalid structure; existing data was not replaced.');
  return saved;
}

export async function appendThesisRevision(userId, input, options = {}) {
  const file = options.file || userFile(userId);
  const storage = options.storage || { readJson, writeJson };
  const record = validate(input);
  const prior = queues.get(file) || Promise.resolve();
  const task = prior.catch(() => {}).then(async () => {
    const saved = await storage.readJson(file, { version: 1, userId: String(userId), revisions: [] });
    if (saved?.version !== 1 || saved.userId !== String(userId) || !Array.isArray(saved.revisions)
      || (saved.reviews !== undefined && !Array.isArray(saved.reviews))
      || (saved.assessments !== undefined && !Array.isArray(saved.assessments))
      || (saved.performanceSnapshots !== undefined && !Array.isArray(saved.performanceSnapshots)))
      throw new Error('Investment thesis journal has invalid structure; existing data was not replaced.');
    const priorRevisions = saved.revisions.filter((row) => String(row.assetId).toLowerCase() === record.assetId.toLowerCase());
    const entry = Object.freeze({ ...record, revision: priorRevisions.reduce((maximum, row) => Math.max(maximum, Number(row.revision) || 0), 0) + 1,
      createdAt: new Date(options.now ?? Date.now()).toISOString() });
    const next = { ...saved, version: 1, userId: String(userId), revisions: [...saved.revisions, entry], reviews: saved.reviews || [], assessments: saved.assessments || [], performanceSnapshots: saved.performanceSnapshots || [], updatedAt: entry.createdAt };
    await storage.writeJson(file, next);
    return { entry, journal: next };
  });
  queues.set(file, task);
  try { return await task; }
  finally { if (queues.get(file) === task) queues.delete(file); }
}

export async function appendThesisEvidenceReview(userId, input, options = {}) {
  const file = options.file || userFile(userId);
  const storage = options.storage || { readJson, writeJson };
  const record = validateEvidenceReview(input);
  const prior = queues.get(file) || Promise.resolve();
  const task = prior.catch(() => {}).then(async () => {
    const saved = await storage.readJson(file, { version: 1, userId: String(userId), revisions: [], reviews: [] });
    if (saved?.version !== 1 || saved.userId !== String(userId) || !Array.isArray(saved.revisions)
      || (saved.reviews !== undefined && !Array.isArray(saved.reviews))
      || (saved.assessments !== undefined && !Array.isArray(saved.assessments))
      || (saved.performanceSnapshots !== undefined && !Array.isArray(saved.performanceSnapshots)))
      throw new Error('Investment thesis journal has invalid structure; existing data was not replaced.');
    const latest = latestTheses(saved).find((row) => row.assetId.toLowerCase() === record.assetId.toLowerCase());
    if (!latest) throw new Error(`No saved thesis exists for ${record.assetId}. Add a thesis before recording an evidence review.`);
    const review = Object.freeze({ ...record, thesisRevision: Number(latest.revision), reviewNumber: (saved.reviews || []).filter((row) => row.assetId.toLowerCase() === record.assetId).length + 1 });
    const next = { ...saved, version: 1, userId: String(userId), revisions: saved.revisions, assessments: saved.assessments || [],
      reviews: [...(saved.reviews || []), review], updatedAt: review.observedAt };
    await storage.writeJson(file, next);
    return { review, priorReview: (saved.reviews || []).filter((row) => row.assetId.toLowerCase() === record.assetId).at(-1) || null, journal: next };
  });
  queues.set(file, task);
  try { return await task; }
  finally { if (queues.get(file) === task) queues.delete(file); }
}

export async function appendThesisAssessment(userId, input, options = {}) {
  const file = options.file || userFile(userId);
  const storage = options.storage || { readJson, writeJson };
  const requestedAsset = String(input.assetId || '').trim();
  const status = String(input.status || '');
  const notes = String(input.notes || '').trim();
  const assessedAt = new Date(input.assessedAt || options.now || Date.now()).toISOString();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(requestedAsset)) throw new Error('Assessment requires an exact provider asset id or ticker.');
  if (!THESIS_ASSESSMENTS.has(status)) throw new Error('Choose a supported personal thesis assessment.');
  if (!notes || notes.length > 800) throw new Error('Assessment notes must contain 1–800 characters.');
  const prior = queues.get(file) || Promise.resolve();
  const task = prior.catch(() => {}).then(async () => {
    const saved = await storage.readJson(file, { version: 1, userId: String(userId), revisions: [], assessments: [] });
    if (saved?.version !== 1 || saved.userId !== String(userId) || !Array.isArray(saved.revisions)
      || (saved.reviews !== undefined && !Array.isArray(saved.reviews)) || (saved.assessments !== undefined && !Array.isArray(saved.assessments))
      || (saved.performanceSnapshots !== undefined && !Array.isArray(saved.performanceSnapshots)))
      throw new Error('Investment thesis journal has invalid structure; existing data was not replaced.');
    const thesis = latestTheses(saved).find((row) => row.assetId.toLowerCase() === requestedAsset.toLowerCase());
    if (!thesis) throw new Error(`No saved thesis exists for ${requestedAsset}. Add a thesis before recording an assessment.`);
    const assessments = saved.assessments || [];
    const entry = Object.freeze({ assetId: thesis.assetId, thesisRevision: Number(thesis.revision), status, notes,
      assessmentNumber: assessments.filter((row) => String(row.assetId).toLowerCase() === thesis.assetId.toLowerCase()).length + 1, assessedAt });
    const next = { ...saved, version: 1, userId: String(userId), assessments: [...assessments, entry], updatedAt: assessedAt };
    await storage.writeJson(file, next);
    return { entry, journal: next };
  });
  queues.set(file, task);
  try { return await task; }
  finally { if (queues.get(file) === task) queues.delete(file); }
}

export function recentThesisAssessments(journal, assetId, limit = 3) {
  const asset = String(assetId || '').trim().toLowerCase();
  const count = Math.max(1, Math.min(10, Number(limit) || 3));
  return (Array.isArray(journal.assessments) ? journal.assessments : [])
    .filter((row) => String(row.assetId || '').toLowerCase() === asset)
    .sort((a, b) => String(b.assessedAt || '').localeCompare(String(a.assessedAt || '')) || Number(b.assessmentNumber || 0) - Number(a.assessmentNumber || 0)).slice(0, count);
}

export async function appendThesisPerformanceSnapshot(userId, input, options = {}) {
  const file = options.file || userFile(userId);
  const storage = options.storage || { readJson, writeJson };
  const assetId = String(input.assetId || '').trim().toLowerCase();
  const asOf = String(input.asOf || '');
  const observedAt = new Date(input.observedAt || Date.now()).toISOString();
  const assetPrice = Number(input.assetPrice), benchmarkPrice = Number(input.benchmarkPrice);
  const source = String(input.source || '').trim().slice(0, 80);
  const marketKey = String(input.marketKey || '').trim().slice(0, 120);
  const benchmarkSymbol = String(input.benchmarkSymbol || '').trim().toUpperCase().slice(0, 12);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(assetId) || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)
    || !Number.isFinite(Date.parse(`${asOf}T00:00:00.000Z`)) || new Date(`${asOf}T00:00:00.000Z`).toISOString().slice(0, 10) !== asOf
    || asOf > observedAt.slice(0, 10) || !(assetPrice > 0 && benchmarkPrice > 0) || !source || !marketKey || !benchmarkSymbol)
    throw new Error('Performance snapshot requires an exact asset id, completed date, positive prices, benchmark, and provider identity.');
  const prior = queues.get(file) || Promise.resolve();
  const task = prior.catch(() => {}).then(async () => {
    const saved = await storage.readJson(file, { version: 1, userId: String(userId), revisions: [], reviews: [], performanceSnapshots: [] });
    if (saved?.version !== 1 || saved.userId !== String(userId) || !Array.isArray(saved.revisions)
      || (saved.reviews !== undefined && !Array.isArray(saved.reviews))
      || (saved.assessments !== undefined && !Array.isArray(saved.assessments))
      || (saved.performanceSnapshots !== undefined && !Array.isArray(saved.performanceSnapshots)))
      throw new Error('Investment thesis journal has invalid structure; existing data was not replaced.');
    const thesis = latestTheses(saved).find((row) => row.assetId.toLowerCase() === assetId);
    if (!thesis) throw new Error(`No saved thesis exists for ${assetId}. Add a thesis before tracking its reference performance.`);
    const snapshots = saved.performanceSnapshots || [];
    const duplicate = snapshots.find((row) => row.assetId.toLowerCase() === assetId && row.thesisRevision === Number(thesis.revision)
      && row.asOf === asOf && row.marketKey === marketKey);
    if (duplicate) return { snapshot: duplicate, duplicate: true, journal: saved };
    const snapshot = Object.freeze({ assetId, thesisRevision: Number(thesis.revision), horizonMonths: Number(thesis.horizonMonths),
      source, marketKey, benchmarkSymbol, asOf, observedAt, assetPrice, benchmarkPrice });
    const next = { ...saved, version: 1, userId: String(userId), performanceSnapshots: [...snapshots, snapshot], updatedAt: observedAt };
    await storage.writeJson(file, next);
    return { snapshot, duplicate: false, journal: next };
  });
  queues.set(file, task);
  try { return await task; }
  finally { if (queues.get(file) === task) queues.delete(file); }
}

export function summarizeThesisPerformance(journal, assetId) {
  const asset = String(assetId || '').trim().toLowerCase();
  const thesis = latestTheses(journal).find((row) => row.assetId.toLowerCase() === asset);
  if (!thesis) return null;
  const rows = (Array.isArray(journal.performanceSnapshots) ? journal.performanceSnapshots : [])
    .filter((row) => row.assetId.toLowerCase() === asset && Number(row.thesisRevision) === Number(thesis.revision))
    .sort((a, b) => String(a.asOf).localeCompare(String(b.asOf)) || String(a.observedAt).localeCompare(String(b.observedAt)));
  if (!rows.length) return { thesis, baseline: null, latest: null, snapshots: [] };
  const latest = rows.at(-1);
  const comparable = rows.filter((row) => row.marketKey === latest.marketKey && row.source === latest.source
    && row.benchmarkSymbol === latest.benchmarkSymbol);
  const baseline = comparable[0];
  const elapsedDays = Math.max(0, (Date.parse(`${latest.asOf}T00:00:00.000Z`) - Date.parse(`${baseline.asOf}T00:00:00.000Z`)) / 86_400_000);
  const assetReturnPct = (latest.assetPrice / baseline.assetPrice - 1) * 100;
  const benchmarkReturnPct = (latest.benchmarkPrice / baseline.benchmarkPrice - 1) * 100;
  const observedDrawdownPct = (key) => {
    if (comparable.length < 2) return null;
    let peak = Number(comparable[0][key]), worst = 0;
    for (const row of comparable.slice(1)) {
      const price = Number(row[key]);
      if (!(price > 0) || !(peak > 0)) continue;
      worst = Math.min(worst, (price / peak - 1) * 100);
      peak = Math.max(peak, price);
    }
    return worst;
  };
  return { thesis, baseline, latest, snapshots: rows.length, comparableSnapshots: comparable.length, elapsedDays,
    assetReturnPct, benchmarkReturnPct, relativeReturnPp: assetReturnPct - benchmarkReturnPct,
    assetObservedMaxDrawdownPct: observedDrawdownPct('assetPrice'), benchmarkObservedMaxDrawdownPct: observedDrawdownPct('benchmarkPrice'),
    horizonDaysApprox: Number(thesis.horizonMonths) * 365.2425 / 12,
    horizonComplete: elapsedDays >= Number(thesis.horizonMonths) * 365.2425 / 12,
    providerChanged: baseline.asOf !== rows[0].asOf || baseline.marketKey !== rows[0].marketKey };
}

export function latestTheses(journal) {
  const latest = new Map();
  for (const row of journal.revisions) {
    const key = String(row.assetId).toLowerCase();
    const prior = latest.get(key);
    if (!prior || Number(row.revision) > Number(prior.revision)) latest.set(key, row);
  }
  return [...latest.values()].sort((a, b) => String(a.assetId).localeCompare(String(b.assetId)));
}

export function thesisReviewPrompts(thesis) {
  const type = String(thesis?.thesisType || 'other');
  const prompts = {
    network_adoption: ['Is independent network use growing, or are activity and volume mainly incentive-driven?', 'Does this token capture value from that use rather than value accruing only to applications or validators?', 'What observable adoption evidence would disconfirm the thesis?'],
    token_value_capture: ['Is there a clear, durable mechanism that links protocol use to demand for this token?', 'How do issuance, unlocks, staking, burns, and concentration affect holder dilution and control?', 'What evidence would show usage is growing without improving token value capture?'],
    infrastructure: ['Is the network gaining sustained users, developers, or integrations that depend on this infrastructure?', 'Does the token have a necessary role in paying for, securing, or governing the service?', 'What security, decentralization, or competitive evidence could invalidate the thesis?'],
    defi: ['Are usage, liquidity, and protocol revenue organic and resilient across market conditions?', 'Who captures fees, and what enforceable mechanism connects protocol success to this token?', 'What smart-contract, oracle, governance, liquidity, or regulatory risk could impair the thesis?'],
    store_of_value: ['What supports durable demand and liquidity beyond short-term price momentum?', 'How do supply rules, custody concentration, security, and regulatory access affect the downside case?', 'What evidence would challenge the claimed monetary or scarcity properties?'],
    payments: ['Is real payment usage increasing outside subsidized or circular activity?', 'Do fees, settlement performance, volatility, and distribution support continued adoption?', 'What competing network or regulatory change could make this asset less useful?'],
    speculative_long_duration: ['Which development milestone would materially reduce the chance of permanent impairment?', 'How do unlocks, emissions, concentration, liquidity, and security change the downside case?', 'What evidence would trigger a thesis review before the planned date?'],
    other: ['Which observed fact most directly tests the written thesis and assumptions?', 'What evidence supports the bear case or contradicts the base case?', 'Is value accruing to this token specifically, and what evidence is still missing?']
  };
  return prompts[type] || prompts.other;
}

export function recentThesisEvidenceReviews(journal, assetId, limit = 3) {
  const asset = String(assetId || '').trim().toLowerCase();
  const count = Math.max(1, Math.min(3, Number.isInteger(Number(limit)) ? Number(limit) : 3));
  return (Array.isArray(journal.reviews) ? journal.reviews : [])
    .filter((row) => String(row.assetId || '').toLowerCase() === asset)
    .sort((a, b) => String(b.observedAt || '').localeCompare(String(a.observedAt || '')))
    .slice(0, count);
}

export function thesisEvidenceCoverage(journal, assetId) {
  const asset = String(assetId || '').trim().toLowerCase();
  const review = (Array.isArray(journal.reviews) ? journal.reviews : [])
    .filter((row) => String(row.assetId || '').toLowerCase() === asset)
    .sort((a, b) => String(b.observedAt || '').localeCompare(String(a.observedAt || '')))[0] || null;
  const facts = new Map((review?.facts || []).map((fact) => [fact.key, fact]));
  const domains = [
    ['Market snapshot', ['price_usd', 'market_cap_usd', 'volume_24h_usd', 'change_24h_pct', 'change_7d_pct']],
    ['Supply and dilution context', ['circulating_supply', 'total_supply', 'max_supply', 'fdv_usd']],
    ['Observed supply history', ['circulating_supply_change_30d', 'circulating_supply_change_90d', 'circulating_supply_change_365d', 'total_supply_change_30d', 'total_supply_change_90d', 'total_supply_change_365d']]
    ,['Protocol TVL history', ['protocol_tvl_usd', 'protocol_tvl_change_30d', 'protocol_tvl_change_90d', 'protocol_tvl_change_365d']]
    ,['Protocol revenue and token value capture', ['protocol_gross_revenue_usd', 'token_holder_net_income_usd', 'protocol_earnings_usd']]
    ,['Protocol users and transactions', ['protocol_active_users_24h', 'protocol_active_users_7d', 'protocol_active_users_30d', 'protocol_active_users_1y', 'protocol_transactions_24h', 'protocol_transactions_7d', 'protocol_transactions_30d', 'protocol_transactions_1y']]
    ,['Emission and supply schedule', ['protocol_max_supply', 'protocol_adjusted_supply', 'protocol_incentive_supply', 'protocol_non_incentive_supply']]
    ,['GitHub repository activity', ['github_commits_recent_90d', 'github_commits_prior_90d', 'github_contributors_recent_90d', 'github_contributors_prior_90d']]
  ].map(([label, keys]) => {
    const observed = keys.filter((key) => Number.isFinite(facts.get(key)?.value)).length;
    const datedFacts = keys.map((key) => facts.get(key)).filter((fact) => Number.isFinite(fact?.value))
      .map((fact) => ({ periodEnd: String(fact.periodEnd || '').slice(0, 32), time: Date.parse(fact.periodEnd || '') }))
      .filter((fact) => Number.isFinite(fact.time));
    const newest = datedFacts.sort((a, b) => b.time - a.time)[0] || null;
    const captureTime = Date.parse(review?.observedAt || '');
    const sources = [...new Set(keys.map((key) => facts.get(key)).filter((fact) => Number.isFinite(fact?.value) && fact.factSource)
      .map((fact) => String(fact.factSource).slice(0, 120)))].slice(0, 3);
    const periodDeltaDays = newest && Number.isFinite(captureTime) ? (captureTime - newest.time) / 86_400_000 : null;
    return { label, observed, total: keys.length, status: observed === 0 ? 'not observed' : observed === keys.length ? 'captured' : 'partial',
      latestPeriodEnd: newest?.periodEnd || '', periodAgeDays: periodDeltaDays === null ? null : Math.floor(Math.abs(periodDeltaDays)),
      periodRelation: periodDeltaDays === null ? '' : periodDeltaDays < 0 ? 'after_capture' : 'before_capture', sources };
  });
  return { assetId: asset, review, protocol: review?.protocolSummary || null, github: review?.githubSummary || null, domains, fieldsObserved: [...facts.values()].filter((fact) => Number.isFinite(fact.value)).length,
    fieldsReported: facts.size };
}

export function compareProtocolActivityCaptures(current, prior) {
  const currentSlug = String(current?.protocolSummary?.slug || '').trim().toLowerCase();
  const priorSlug = String(prior?.protocolSummary?.slug || '').trim().toLowerCase();
  const currentAt = Date.parse(current?.observedAt || '');
  const priorAt = Date.parse(prior?.observedAt || '');
  if (!currentSlug || currentSlug !== priorSlug || !Number.isFinite(currentAt) || !Number.isFinite(priorAt) || currentAt <= priorAt) return [];
  const activityKeys = new Set(['protocol_active_users_24h', 'protocol_active_users_7d', 'protocol_active_users_30d', 'protocol_active_users_1y',
    'protocol_transactions_24h', 'protocol_transactions_7d', 'protocol_transactions_30d', 'protocol_transactions_1y']);
  const priorFacts = new Map((Array.isArray(prior.facts) ? prior.facts : []).filter((fact) => activityKeys.has(fact.key)).map((fact) => [fact.key, fact]));
  return (Array.isArray(current.facts) ? current.facts : []).flatMap((fact) => {
    const previous = priorFacts.get(fact.key);
    if (!activityKeys.has(fact.key) || !previous || fact.unit !== previous.unit || !Number.isFinite(fact.value) || !Number.isFinite(previous.value)
      || fact.value < 0 || previous.value <= 0) return [];
    return [{ key: fact.key, label: fact.label, unit: fact.unit, priorValue: previous.value, currentValue: fact.value,
      changePct: (fact.value / previous.value - 1) * 100, priorObservedAt: prior.observedAt, currentObservedAt: current.observedAt }];
  });
}

export function summarizeProtocolActivityHistory(reviews, current, limit = 4) {
  const currentSlug = String(current?.protocolSummary?.slug || '').trim().toLowerCase();
  const currentAsset = String(current?.assetId || '').trim().toLowerCase();
  const currentAt = Date.parse(current?.observedAt || '');
  if (!currentSlug || !currentAsset || !Number.isFinite(currentAt) || !Array.isArray(reviews)) return [];
  const activityKeys = new Set(['protocol_active_users_24h', 'protocol_active_users_7d', 'protocol_active_users_30d', 'protocol_active_users_1y',
    'protocol_transactions_24h', 'protocol_transactions_7d', 'protocol_transactions_30d', 'protocol_transactions_1y']);
  const priorByKey = new Map();
  for (const review of reviews) {
    if (String(review?.assetId || '').trim().toLowerCase() !== currentAsset) continue;
    if (String(review?.protocolSummary?.slug || '').trim().toLowerCase() !== currentSlug) continue;
    const observedAt = Date.parse(review?.observedAt || '');
    if (!Number.isFinite(observedAt) || observedAt >= currentAt) continue;
    for (const fact of Array.isArray(review?.facts) ? review.facts : []) {
      if (!activityKeys.has(fact.key) || !Number.isFinite(fact.value) || fact.value < 0 || !fact.unit) continue;
      const key = JSON.stringify([fact.key, fact.unit]);
      const rows = priorByKey.get(key) || [];
      rows.push({ observedAt, value: fact.value });
      priorByKey.set(key, rows);
    }
  }
  const maximum = Math.max(2, Math.min(6, Number.isInteger(limit) ? limit : 4));
  return (Array.isArray(current.facts) ? current.facts : []).flatMap((fact) => {
    if (!activityKeys.has(fact.key) || !Number.isFinite(fact.value) || fact.value < 0 || !fact.unit) return [];
    const key = JSON.stringify([fact.key, fact.unit]);
    const previous = (priorByKey.get(key) || []).sort((a, b) => a.observedAt - b.observedAt);
    const deduped = new Map(previous.map((row) => [row.observedAt, row]));
    const observations = [...deduped.values()].sort((a, b) => a.observedAt - b.observedAt)
      .slice(-(maximum - 1)).concat({ observedAt: currentAt, value: fact.value });
    if (observations.length < 2) return [];
    const first = observations[0], last = observations.at(-1);
    let risingSteps = 0, fallingSteps = 0;
    for (let index = 1; index < observations.length; index += 1) {
      if (observations[index].value > observations[index - 1].value) risingSteps += 1;
      else if (observations[index].value < observations[index - 1].value) fallingSteps += 1;
    }
    return [{ key: fact.key, label: fact.label, unit: fact.unit, sampleCount: observations.length,
      firstValue: first.value, latestValue: last.value, firstObservedAt: new Date(first.observedAt).toISOString(),
      latestObservedAt: new Date(last.observedAt).toISOString(), changePct: first.value > 0 ? (last.value / first.value - 1) * 100 : null,
      risingSteps, fallingSteps, flatSteps: observations.length - 1 - risingSteps - fallingSteps }];
  });
}

export function thesesDueForReview(journal, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))) throw new Error('Today must be a YYYY-MM-DD date.');
  const todayDate = new Date(`${today}T00:00:00.000Z`);
  if (Number.isNaN(todayDate.getTime()) || todayDate.toISOString().slice(0, 10) !== today) throw new Error('Today must be a real calendar date.');
  return latestTheses(journal).flatMap((row) => {
    const reviewDate = String(row.reviewDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewDate)) return [];
    const review = new Date(`${reviewDate}T00:00:00.000Z`);
    if (Number.isNaN(review.getTime()) || review.toISOString().slice(0, 10) !== reviewDate || reviewDate > today) return [];
    const daysOverdue = Math.round((todayDate.getTime() - review.getTime()) / 86_400_000);
    return [{ ...row, reviewStatus: daysOverdue === 0 ? 'DUE TODAY' : 'OVERDUE', daysOverdue }];
  }).sort((a, b) => b.daysOverdue - a.daysOverdue || String(a.assetId).localeCompare(String(b.assetId)));
}
