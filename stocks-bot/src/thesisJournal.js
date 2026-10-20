import path from 'node:path';
import { dataDir } from './config.js';
import { readJson, writeJson } from './storage.js';

const queues = new Map();
const MAX_TEXT = Object.freeze({ thesis: 1200, assumptions: 800, baseCase: 800, bullCase: 800, bearCase: 800, invalidation: 800, catalysts: 600 });
const THESIS_TYPES = new Set(['compounder', 'growth', 'value', 'turnaround', 'cyclical', 'income', 'special_situation', 'secular_theme', 'core_holding', 'speculative_long_duration', 'other']);
const THESIS_ASSESSMENTS = new Set(['thesis_intact', 'mixed', 'weakened', 'invalidation_met', 'insufficient_evidence']);

function userFile(userId) {
  const id = String(userId || '');
  if (!/^\d{5,25}$/.test(id)) throw new Error('A valid Discord user id is required.');
  return path.join(dataDir, `investment-thesis-${id}.json`);
}

function validate(input) {
  const assetId = String(input.assetId || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.^-]{0,11}$/.test(assetId)) throw new Error('Enter a valid U.S. stock ticker, such as NVDA.');
  const thesisType = String(input.thesisType || '');
  if (!THESIS_TYPES.has(thesisType)) throw new Error('Choose a supported stock thesis type.');
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
  return { assetId, thesisType, horizonMonths, reviewDate, ...fields, sources };
}

function validateEvidenceReview(input) {
  const assetId = String(input.assetId || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.^-]{0,11}$/.test(assetId)) throw new Error('Evidence review requires a valid U.S. stock ticker.');
  const source = String(input.source || '').trim().slice(0, 100);
  const observedAt = new Date(input.observedAt || Date.now()).toISOString();
  const status = ['partial', 'coverage_limited', 'unavailable'].includes(input.status) ? input.status : 'partial';
  const normalizeFiling = (value) => value && typeof value === 'object' ? {
    form: String(value.form || '').slice(0, 12), filedAt: String(value.filedAt || '').slice(0, 20),
    periodEnd: String(value.periodEnd || '').slice(0, 10), accession: String(value.accession || '').slice(0, 24),
    url: String(value.url || '').slice(0, 500)
  } : {};
  const filing = normalizeFiling(input.filing), quarterlyFiling = normalizeFiling(input.quarterlyFiling);
  if ([filing, quarterlyFiling].some((row) => row.url && !/^https:\/\//i.test(row.url))) throw new Error('Evidence source URL must use HTTPS.');
  const facts = (Array.isArray(input.facts) ? input.facts : []).slice(0, 100).map((fact) => ({
    key: String(fact.key || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 48),
    label: String(fact.label || '').slice(0, 80),
    value: fact.value === null || fact.value === undefined || fact.value === '' || !Number.isFinite(Number(fact.value)) ? null : Number(fact.value),
    unit: String(fact.unit || '').slice(0, 24), periodStart: String(fact.periodStart || '').slice(0, 10), periodEnd: String(fact.periodEnd || '').slice(0, 10),
    factSource: String(fact.factSource || '').slice(0, 240)
  })).filter((fact) => fact.key && fact.label);
  return Object.freeze({ assetId, source: source || 'SEC EDGAR Company Facts', status, observedAt, filing, quarterlyFiling,
    note: String(input.note || '').slice(0, 240), facts });
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
    const priorRevisions = saved.revisions.filter((row) => String(row.assetId).toUpperCase() === record.assetId);
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
    const latest = latestTheses(saved).find((row) => row.assetId === record.assetId);
    if (!latest) throw new Error(`No saved thesis exists for ${record.assetId}. Add a thesis before recording an evidence review.`);
    const review = Object.freeze({ ...record, thesisRevision: Number(latest.revision), reviewNumber: (saved.reviews || []).filter((row) => row.assetId === record.assetId).length + 1 });
    const next = { ...saved, version: 1, userId: String(userId), revisions: saved.revisions, assessments: saved.assessments || [],
      reviews: [...(saved.reviews || []), review], updatedAt: review.observedAt };
    await storage.writeJson(file, next);
    return { review, priorReview: (saved.reviews || []).filter((row) => row.assetId === record.assetId).at(-1) || null, journal: next };
  });
  queues.set(file, task);
  try { return await task; }
  finally { if (queues.get(file) === task) queues.delete(file); }
}

export async function appendThesisAssessment(userId, input, options = {}) {
  const file = options.file || userFile(userId);
  const storage = options.storage || { readJson, writeJson };
  const assetId = String(input.assetId || '').trim().toUpperCase();
  const status = String(input.status || '');
  const notes = String(input.notes || '').trim();
  const assessedAt = new Date(input.assessedAt || options.now || Date.now()).toISOString();
  if (!/^[A-Z0-9][A-Z0-9.^-]{0,11}$/.test(assetId)) throw new Error('Assessment requires a valid U.S. stock ticker.');
  if (!THESIS_ASSESSMENTS.has(status)) throw new Error('Choose a supported personal thesis assessment.');
  if (!notes || notes.length > 800) throw new Error('Assessment notes must contain 1–800 characters.');
  const prior = queues.get(file) || Promise.resolve();
  const task = prior.catch(() => {}).then(async () => {
    const saved = await storage.readJson(file, { version: 1, userId: String(userId), revisions: [], assessments: [] });
    if (saved?.version !== 1 || saved.userId !== String(userId) || !Array.isArray(saved.revisions)
      || (saved.reviews !== undefined && !Array.isArray(saved.reviews)) || (saved.assessments !== undefined && !Array.isArray(saved.assessments))
      || (saved.performanceSnapshots !== undefined && !Array.isArray(saved.performanceSnapshots)))
      throw new Error('Investment thesis journal has invalid structure; existing data was not replaced.');
    const thesis = latestTheses(saved).find((row) => row.assetId === assetId);
    if (!thesis) throw new Error(`No saved thesis exists for ${assetId}. Add a thesis before recording an assessment.`);
    const assessments = saved.assessments || [];
    const entry = Object.freeze({ assetId, thesisRevision: Number(thesis.revision), status, notes,
      assessmentNumber: assessments.filter((row) => row.assetId === assetId).length + 1, assessedAt });
    const next = { ...saved, version: 1, userId: String(userId), assessments: [...assessments, entry], updatedAt: assessedAt };
    await storage.writeJson(file, next);
    return { entry, journal: next };
  });
  queues.set(file, task);
  try { return await task; }
  finally { if (queues.get(file) === task) queues.delete(file); }
}

export function recentThesisAssessments(journal, assetId, limit = 3) {
  const asset = String(assetId || '').trim().toUpperCase();
  const count = Math.max(1, Math.min(10, Number(limit) || 3));
  return (Array.isArray(journal.assessments) ? journal.assessments : [])
    .filter((row) => String(row.assetId || '').toUpperCase() === asset)
    .sort((a, b) => String(b.assessedAt || '').localeCompare(String(a.assessedAt || '')) || Number(b.assessmentNumber || 0) - Number(a.assessmentNumber || 0)).slice(0, count);
}

export async function appendThesisPerformanceSnapshot(userId, input, options = {}) {
  const file = options.file || userFile(userId);
  const storage = options.storage || { readJson, writeJson };
  const assetId = String(input.assetId || '').trim().toUpperCase();
  const asOf = String(input.asOf || '');
  const observedAt = new Date(input.observedAt || Date.now()).toISOString();
  const assetPrice = Number(input.assetPrice), benchmarkPrice = Number(input.benchmarkPrice);
  const source = String(input.source || '').trim().slice(0, 80);
  const marketKey = String(input.marketKey || '').trim().slice(0, 120);
  const benchmarkSymbol = String(input.benchmarkSymbol || '').trim().toUpperCase().slice(0, 12);
  if (!/^[A-Z0-9][A-Z0-9.^-]{0,11}$/.test(assetId) || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)
    || !Number.isFinite(Date.parse(`${asOf}T00:00:00.000Z`)) || new Date(`${asOf}T00:00:00.000Z`).toISOString().slice(0, 10) !== asOf
    || asOf > observedAt.slice(0, 10) || !(assetPrice > 0 && benchmarkPrice > 0) || !source || !marketKey || !benchmarkSymbol)
    throw new Error('Performance snapshot requires an exact ticker, completed date, positive prices, benchmark, and provider identity.');
  const prior = queues.get(file) || Promise.resolve();
  const task = prior.catch(() => {}).then(async () => {
    const saved = await storage.readJson(file, { version: 1, userId: String(userId), revisions: [], reviews: [], performanceSnapshots: [] });
    if (saved?.version !== 1 || saved.userId !== String(userId) || !Array.isArray(saved.revisions)
      || (saved.reviews !== undefined && !Array.isArray(saved.reviews))
      || (saved.assessments !== undefined && !Array.isArray(saved.assessments))
      || (saved.performanceSnapshots !== undefined && !Array.isArray(saved.performanceSnapshots)))
      throw new Error('Investment thesis journal has invalid structure; existing data was not replaced.');
    const thesis = latestTheses(saved).find((row) => row.assetId === assetId);
    if (!thesis) throw new Error(`No saved thesis exists for ${assetId}. Add a thesis before tracking its reference performance.`);
    const snapshots = saved.performanceSnapshots || [];
    const duplicate = snapshots.find((row) => row.assetId === assetId && row.thesisRevision === Number(thesis.revision)
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

function addCalendarMonths(dateKey, months) {
  const source = new Date(`${dateKey}T00:00:00.000Z`);
  const sourceDay = source.getUTCDate();
  const absoluteMonth = source.getUTCFullYear() * 12 + source.getUTCMonth() + months;
  const year = Math.floor(absoluteMonth / 12);
  const month = absoluteMonth - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(sourceDay, lastDay))).toISOString().slice(0, 10);
}

export function summarizeThesisPerformance(journal, assetId) {
  const asset = String(assetId || '').trim().toUpperCase();
  const thesis = latestTheses(journal).find((row) => row.assetId === asset);
  if (!thesis) return null;
  const rows = (Array.isArray(journal.performanceSnapshots) ? journal.performanceSnapshots : [])
    .filter((row) => row.assetId === asset && Number(row.thesisRevision) === Number(thesis.revision))
    .sort((a, b) => String(a.asOf).localeCompare(String(b.asOf)) || String(a.observedAt).localeCompare(String(b.observedAt)));
  if (!rows.length) return { thesis, baseline: null, latest: null, snapshots: [] };
  const latest = rows.at(-1);
  const comparable = rows.filter((row) => row.marketKey === latest.marketKey && row.source === latest.source
    && row.benchmarkSymbol === latest.benchmarkSymbol);
  const baseline = comparable[0];
  const horizonTargetAsOf = addCalendarMonths(baseline.asOf, Number(thesis.horizonMonths));
  const horizonMark = comparable.find((row) => row.asOf >= horizonTargetAsOf) || null;
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
  const horizonOutcome = horizonMark ? Object.freeze({ targetAsOf: horizonTargetAsOf, observedAsOf: horizonMark.asOf,
    elapsedDays: Math.max(0, (Date.parse(`${horizonMark.asOf}T00:00:00.000Z`) - Date.parse(`${baseline.asOf}T00:00:00.000Z`)) / 86_400_000),
    assetReturnPct: (horizonMark.assetPrice / baseline.assetPrice - 1) * 100,
    benchmarkReturnPct: (horizonMark.benchmarkPrice / baseline.benchmarkPrice - 1) * 100,
    relativeReturnPp: (horizonMark.assetPrice / baseline.assetPrice - horizonMark.benchmarkPrice / baseline.benchmarkPrice) * 100 }) : null;
  return { thesis, baseline, latest, snapshots: rows.length, comparableSnapshots: comparable.length, elapsedDays,
    assetReturnPct, benchmarkReturnPct, relativeReturnPp: assetReturnPct - benchmarkReturnPct,
    assetObservedMaxDrawdownPct: observedDrawdownPct('assetPrice'), benchmarkObservedMaxDrawdownPct: observedDrawdownPct('benchmarkPrice'),
    horizonTargetAsOf, horizonOutcome,
    horizonDaysApprox: Number(thesis.horizonMonths) * 365.2425 / 12,
    horizonComplete: latest.asOf >= horizonTargetAsOf,
    providerChanged: baseline.asOf !== rows[0].asOf || baseline.marketKey !== rows[0].marketKey };
}

export function latestTheses(journal) {
  const latest = new Map();
  for (const row of journal.revisions) {
    const key = String(row.assetId).toUpperCase();
    const prior = latest.get(key);
    if (!prior || Number(row.revision) > Number(prior.revision)) latest.set(key, row);
  }
  return [...latest.values()].sort((a, b) => String(a.assetId).localeCompare(String(b.assetId)));
}

export function thesisReviewPrompts(thesis) {
  const type = String(thesis?.thesisType || 'other');
  const prompts = {
    compounder: ['Are revenue and free cash flow growing per diluted share, with margins and balance-sheet capacity supporting reinvestment?', 'Is share dilution or stock-based compensation offsetting the company’s reported growth?', 'What new evidence would weaken the durability of its competitive advantage?'],
    growth: ['Is reported growth converting into operating cash flow and improving unit economics?', 'Are margins, funding needs, and diluted shares moving in a direction consistent with the base case?', 'What measurable milestone would disconfirm the growth assumptions?'],
    value: ['What evidence supports normalized cash generation rather than a temporary peak in earnings?', 'Does current debt, liquidity, or impairment risk change the downside case?', 'Which valuation assumption matters most, and what evidence could invalidate it?'],
    turnaround: ['Is operating performance improving across more than one reporting period?', 'Is the company funded well enough to reach the milestones in the thesis without unacceptable dilution?', 'Which recovery milestone has failed or been delayed, and what would that mean for invalidation?'],
    cyclical: ['Where might the business sit in its cycle, and are current margins unusually high or low?', 'Do cash flow, debt, and liquidity remain resilient through a weaker demand scenario?', 'What evidence distinguishes a normal cycle downturn from structural deterioration?'],
    income: ['Are distributions covered by recurring cash generation after necessary investment?', 'Have debt, payout, or share-count changes weakened the ability to sustain income?', 'Which source is still needed to verify dividend history and coverage?'],
    special_situation: ['Has the event or catalyst in the thesis occurred on the expected terms and timeline?', 'What is the downside if the catalyst is delayed, repriced, or rejected?', 'Does the event still create value for common shareholders after financing and dilution?'],
    secular_theme: ['Is this company capturing durable demand from the theme, rather than merely operating in the same industry?', 'Do growth and cash-flow evidence support the thesis at this valuation?', 'What evidence would show the theme is real but this company is not a beneficiary?'],
    core_holding: ['Does the business remain financially resilient and aligned with its intended portfolio role?', 'Have concentration, debt, or competitive risks changed materially?', 'What portfolio-level fact is needed before deciding whether the position still fits?'],
    speculative_long_duration: ['Which milestone would materially reduce the chance of permanent loss?', 'How much funding, dilution, or execution risk remains before the thesis can be tested?', 'What evidence would trigger a thesis review before the planned date?'],
    other: ['Which current fact most directly tests the written thesis and its assumptions?', 'What evidence supports the bear case or contradicts the base case?', 'Has any stated invalidation condition occurred, or is required evidence still missing?']
  };
  return prompts[type] || prompts.other;
}

export function recentThesisEvidenceReviews(journal, assetId, limit = 3) {
  const asset = String(assetId || '').trim().toUpperCase();
  const count = Math.max(1, Math.min(3, Number.isInteger(Number(limit)) ? Number(limit) : 3));
  return (Array.isArray(journal.reviews) ? journal.reviews : [])
    .filter((row) => String(row.assetId || '').toUpperCase() === asset)
    .sort((a, b) => String(b.observedAt || '').localeCompare(String(a.observedAt || '')))
    .slice(0, count);
}

export function compareThesisGrowthEvidence(current, prior) {
  if (!current || !prior || String(current.assetId || '').toUpperCase() !== String(prior.assetId || '').toUpperCase()
    || current.source !== prior.source || current.source !== 'SEC EDGAR Company Facts'
    || !(new Date(current.observedAt).getTime() > new Date(prior.observedAt).getTime())) return [];
  const allowed = new Set(['revenue_growth_pct', 'diluted_share_growth_pct', 'q_revenue_growth_pct']);
  const previous = new Map((Array.isArray(prior.facts) ? prior.facts : []).filter((fact) => allowed.has(fact.key)
    && fact.unit === 'percent' && Number.isFinite(fact.value) && /^\d{4}-\d{2}-\d{2}$/.test(fact.periodEnd || '')).map((fact) => [fact.key, fact]));
  return (Array.isArray(current.facts) ? current.facts : []).flatMap((fact) => {
    const old = previous.get(fact.key);
    if (!old || fact.unit !== 'percent' || !Number.isFinite(fact.value) || !/^\d{4}-\d{2}-\d{2}$/.test(fact.periodEnd || '') || fact.periodEnd <= old.periodEnd) return [];
    return [{ key: fact.key, label: fact.label, priorValue: old.value, currentValue: fact.value,
      changePercentagePoints: fact.value - old.value, priorPeriodEnd: old.periodEnd, currentPeriodEnd: fact.periodEnd }];
  });
}

export function thesisEvidenceCoverage(journal, assetId) {
  const asset = String(assetId || '').trim().toUpperCase();
  const review = (Array.isArray(journal.reviews) ? journal.reviews : [])
    .filter((row) => String(row.assetId || '').toUpperCase() === asset)
    .sort((a, b) => String(b.observedAt || '').localeCompare(String(a.observedAt || '')))[0] || null;
  const facts = new Map((review?.facts || []).map((fact) => [fact.key, fact]));
  const factFor = (key) => {
    if (!key.endsWith('_')) return facts.get(key);
    return [...facts.values()].filter((fact) => fact.key.startsWith(key))
      .sort((a, b) => String(b.periodEnd || '').localeCompare(String(a.periodEnd || '')))[0];
  };
  const domains = [
    ['Annual operating results', ['revenue', 'netIncome', 'dilutedEps', 'operatingCashFlow', 'freeCashFlow']],
    ['Annual balance sheet/liquidity', ['totalAssets', 'stockholdersEquity', 'cash', 'longTermDebtCurrent', 'longTermDebtNoncurrent', 'currentRatio', 'workingCapital', 'cashLessLongTermDebt']],
    ['Reported annual debt maturities', ['annual_history_debtMaturityNext12Months_', 'annual_history_debtMaturityYearTwo_', 'annual_history_debtMaturityYearThree_', 'annual_history_debtMaturityYearFour_', 'annual_history_debtMaturityYearFive_', 'annual_history_debtMaturityAfterYearFive_']],
    ['Annual capital returns', ['returnOnEquityPct', 'returnOnAssetsPct']],
    ['Annual growth/share count', ['revenue_growth_pct', 'diluted_share_growth_pct', 'sharesOutstanding', 'weightedAverageDilutedShares']],
    ['Latest-quarter facts', ['q_revenue', 'q_netIncome', 'q_dilutedEps', 'q_operatingCashFlow', 'q_freeCashFlow', 'q_currentRatio', 'q_cashLessLongTermDebt', 'q_revenue_growth_pct']],
    ['Price and indicative annual multiples', ['valuation_price', 'valuation_market_cap_estimate', 'valuation_price_to_sales', 'valuation_price_to_earnings', 'valuation_price_to_free_cash_flow', 'valuation_fcf_yield_pct']]
  ].map(([label, keys]) => {
    const observedFacts = keys.map(factFor).filter((fact) => Number.isFinite(fact?.value));
    const observed = observedFacts.length;
    const datedFacts = observedFacts
      .map((fact) => ({ periodEnd: String(fact.periodEnd || '').slice(0, 10), time: Date.parse(fact.periodEnd || '') }))
      .filter((fact) => /^\d{4}-\d{2}-\d{2}$/.test(fact.periodEnd) && Number.isFinite(fact.time));
    const newest = datedFacts.sort((a, b) => b.time - a.time)[0] || null;
    const captureTime = Date.parse(review?.observedAt || '');
    const periodDeltaDays = newest && Number.isFinite(captureTime) ? (captureTime - newest.time) / 86_400_000 : null;
    return { label, observed, total: keys.length, status: observed === 0 ? 'not observed' : observed === keys.length ? 'captured' : 'partial',
      latestPeriodEnd: newest?.periodEnd || '', periodAgeDays: periodDeltaDays === null ? null : Math.floor(Math.abs(periodDeltaDays)),
      periodRelation: periodDeltaDays === null ? '' : periodDeltaDays < 0 ? 'after_capture' : 'before_capture' };
  });
  return { assetId: asset, review, domains, fieldsObserved: [...facts.values()].filter((fact) => Number.isFinite(fact.value)).length,
    fieldsReported: facts.size };
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
