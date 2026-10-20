import { appendFile, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const LOSS_CAUSES = Object.freeze([
  'undetermined', 'valid_setup_lost', 'weak_setup_quality', 'incorrect_market_regime',
  'poor_execution', 'excess_spread_or_slippage', 'bad_stop_placement', 'late_entry',
  'false_breakout', 'catalyst_shock', 'correlated_market_move', 'bad_or_missing_data', 'strategy_bug',
]);
const THESIS_VALIDITY = new Set(['valid', 'invalid', 'uncertain']);
const REVIEW_BASIS = new Set(['paper_ledger', 'external_https']);
const safeTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => value[key] !== undefined).map((key) => [key, stable(value[key])]));
  return value;
}
const digest = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const recordDigest = (record) => {
  const { integrityDigest, ...contents } = record;
  return digest(contents);
};

/** Bind a human review to the complete terminal paper observation, not just a reusable symbol. */
export function paperTradeFingerprint(order) {
  if (order?.status !== 'closed' || !order.orderId || safeTime(order.closedAt) === null) {
    throw new TypeError('A fingerprint requires a closed, dated paper order with an ID.');
  }
  return digest(order);
}

export function resolvePaperTradeReviewPath(ledgerPath) {
  if (typeof ledgerPath !== 'string' || !ledgerPath.trim()) throw new TypeError('Paper ledger path is required.');
  return `${resolve(ledgerPath)}.reviews.jsonl`;
}

function cleanInput(input, order, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Review input must be an object.');
  if (String(input.orderId ?? '') !== String(order.orderId)) throw new TypeError('Review order ID does not match the closed paper order.');
  const reviewer = String(input.reviewer ?? '').trim();
  const summary = String(input.summary ?? '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._ -]{1,79}$/.test(reviewer)) throw new TypeError('Reviewer must be a short safe identifier.');
  if (summary.length < 30 || summary.length > 800) throw new TypeError('Evidence summary must be 30–800 characters.');
  if (!THESIS_VALIDITY.has(input.thesisValidity)) throw new TypeError('Thesis validity must be valid, invalid, or uncertain.');
  const loss = Number.isFinite(Number(order.realizedPnlUsd)) && Number(order.realizedPnlUsd) < 0;
  const lossCause = String(input.lossCause ?? '');
  if (loss ? !LOSS_CAUSES.includes(lossCause) : lossCause !== 'not_applicable') {
    throw new TypeError('Loss cause must match the closed net outcome and supported taxonomy.');
  }
  if (!REVIEW_BASIS.has(input.evidenceBasis)) throw new TypeError('Evidence basis must be paper_ledger or external_https.');
  let sourceUrl = null;
  if (input.evidenceBasis === 'external_https') {
    try {
      const url = new URL(input.sourceUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || url.toString().length > 300) throw new Error('unsafe');
      sourceUrl = url.toString();
    } catch { throw new TypeError('External evidence must have a credential-free HTTPS URL without query or fragment.'); }
  } else if (input.sourceUrl != null && input.sourceUrl !== '') throw new TypeError('Paper-ledger evidence cannot carry an external URL.');
  const evidenceAsOf = safeTime(input.evidenceAsOf);
  const closedAt = safeTime(order.closedAt);
  if (evidenceAsOf === null || evidenceAsOf > now || closedAt === null || now < closedAt) {
    throw new TypeError('Evidence and review timestamps are invalid.');
  }
  return { reviewer, summary, thesisValidity: input.thesisValidity, lossCause,
    evidenceBasis: input.evidenceBasis, sourceUrl,
    evidenceAsOf: new Date(evidenceAsOf).toISOString() };
}

/** Read append-only revisions; malformed or stale-fingerprint rows never become current assessments. */
export async function readPaperTradeReviews({ journalPath, orders = [] }) {
  if (typeof journalPath !== 'string' || !journalPath.trim()) throw new TypeError('Paper review journal path is required.');
  let contents;
  try { contents = await readFile(journalPath, 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') contents = ''; else throw error; }
  const orderById = new Map(orders.filter((order) => order?.status === 'closed' && order.orderId
    && safeTime(order.closedAt) !== null)
    .map((order) => [String(order.orderId), order]));
  const latestByOrder = Object.create(null);
  const diagnostics = { rows: 0, accepted: 0, invalid: 0, missingOrChangedOrder: 0, brokenRevisionChain: 0 };
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    diagnostics.rows++;
    let record;
    try { record = JSON.parse(line); }
    catch { diagnostics.invalid++; continue; }
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || record.schemaVersion !== 1 || record.integrityDigest !== recordDigest(record)
      || !record.reviewId || safeTime(record.reviewedAt) === null) { diagnostics.invalid++; continue; }
    const order = orderById.get(String(record.orderId));
    if (!order || record.orderFingerprint !== paperTradeFingerprint(order)) {
      diagnostics.missingOrChangedOrder++; continue;
    }
    try {
      const reviewedAt = safeTime(record.reviewedAt);
      const normalized = cleanInput(record, order, reviewedAt);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(record.reviewId))
        || Object.entries(normalized).some(([key, value]) => record[key] !== value)) {
        diagnostics.invalid++; continue;
      }
    } catch { diagnostics.invalid++; continue; }
    const prior = latestByOrder[record.orderId];
    if ((prior?.reviewId ?? null) !== (record.supersedesReviewId ?? null)
      || prior && safeTime(record.reviewedAt) < safeTime(prior.reviewedAt)) {
      diagnostics.brokenRevisionChain++; continue;
    }
    latestByOrder[record.orderId] = record;
    diagnostics.accepted++;
  }
  return { latestByOrder, diagnostics };
}

/** Append one manually authored assessment; no strategy rule reads this journal. */
export async function appendPaperTradeReview({ journalPath, orders = [], input, now = Date.now() }) {
  if (!Number.isFinite(now)) throw new TypeError('Review time must be finite.');
  const order = orders.find((row) => String(row?.orderId ?? '') === String(input?.orderId ?? ''));
  if (!order || order.status !== 'closed') throw new TypeError('Review requires an existing closed paper order.');
  const clean = cleanInput(input, order, now);
  const path = resolve(journalPath), lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  let lock;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { lock = await open(lockPath, 'wx'); break; }
    catch (error) { if (error?.code !== 'EEXIST') throw error; await delay(50); }
  }
  if (!lock) throw new Error('Paper review journal is locked; inspect the owner before retrying.');
  try {
    const existing = await readPaperTradeReviews({ journalPath: path, orders });
    if (existing.diagnostics.invalid || existing.diagnostics.missingOrChangedOrder || existing.diagnostics.brokenRevisionChain) {
      throw new Error('Paper review journal has invalid or stale records; inspect it before appending.');
    }
    const prior = existing.latestByOrder[order.orderId];
    if ((input.supersedesReviewId ?? null) !== (prior?.reviewId ?? null)) {
      throw new TypeError('A correction must supersede the latest review ID; initial reviews must not supersede.');
    }
    if (prior && now < safeTime(prior.reviewedAt)) throw new TypeError('Review revisions must be chronological.');
    const record = { schemaVersion: 1, reviewId: randomUUID(), orderId: order.orderId,
      orderFingerprint: paperTradeFingerprint(order), supersedesReviewId: prior?.reviewId ?? null,
      reviewedAt: new Date(now).toISOString(), ...clean,
      semantics: 'Manual operator assessment with cited basis; not an automatically proven cause or strategy approval.' };
    record.integrityDigest = recordDigest(record);
    await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' });
    return record;
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}
