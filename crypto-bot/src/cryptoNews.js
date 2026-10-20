import { createHash } from 'node:crypto';
import { isRetryableProviderFailure, retryPlan } from './retryPolicy.js';
import { assertProviderAvailable, recordProviderCooldown, waitForProviderCooldown } from './providerCooldown.js';
import { recordProviderRequest } from './providerTelemetry.js';

const ENDPOINT = 'https://finnhub.io/api/v1/news';
const SUCCESS_TTL_MS = 3 * 60_000;
const FAILURE_TTL_MS = 30_000;
const MAX_NEWS_AGE_MS = 6 * 60 * 60_000;
const MAX_ITEMS = 12;
const cache = new Map();
const inFlight = new Map();

const HEADLINE_CATEGORIES = Object.freeze([
  { eventType: 'security_incident', pattern: /\b(hack(?:ed|ing)?|exploit(?:ed)?|breach(?:ed)?|drained|stolen|compromised|51\s*%\s*attack)\b/i, direction: 'negative', potentialSeverity: 'high' },
  { eventType: 'network_disruption', pattern: /\b(outage|network (?:down|offline)|halt(?:s|ed)? (?:the )?network|suspend(?:s|ed)? (?:all )?(?:deposits|withdrawals|trading))\b/i, direction: 'negative', potentialSeverity: 'high' },
  { eventType: 'exchange_delisting', pattern: /\b(delist(?:s|ed|ing)?|remove(?:s|d)? .* from (?:spot|trading))\b/i, direction: 'negative', potentialSeverity: 'high' },
  { eventType: 'exchange_listing', pattern: /\b(list(?:s|ed|ing)? .* (?:spot|trading)|adds? .* (?:spot|trading)|launch(?:es|ed)? trading)\b/i, direction: 'unknown', potentialSeverity: 'medium' },
  { eventType: 'regulatory_action', pattern: /\b(ban(?:s|ned)?|lawsuit|sued|charged|enforcement action|regulatory probe)\b/i, direction: 'negative', potentialSeverity: 'high' },
  { eventType: 'regulatory_update', pattern: /\b(SEC|regulator|regulatory|court ruling|legislation|policy)\b/i, direction: 'unknown', potentialSeverity: 'medium' },
  { eventType: 'token_supply_event', pattern: /\b(token unlock|vesting|emissions schedule|supply increase|circulating supply)\b/i, direction: 'unknown', potentialSeverity: 'medium' },
  { eventType: 'institutional_flow', pattern: /\b(ETF|fund flows?|inflows?|outflows?|institutional buying|institutional selling)\b/i, direction: 'unknown', potentialSeverity: 'medium' },
  { eventType: 'protocol_change', pattern: /\b(upgrade|hard[ -]?fork|mainnet launch|network upgrade)\b/i, direction: 'unknown', potentialSeverity: 'medium' },
  { eventType: 'adoption_announcement', pattern: /\b(partnership|integrat(?:e|es|ed|ion)|adoption|payment support)\b/i, direction: 'unknown', potentialSeverity: 'low' },
]);

/**
 * Classify only obvious headline topics for display/research. This deliberately
 * does not estimate price impact, event truth, or scheduled-vs-unexpected status.
 */
export function classifyCryptoHeadline(headline) {
  const text = String(headline || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500);
  const matches = HEADLINE_CATEGORIES.filter((row) => row.pattern.test(text));
  const unverified = /\b(rumou?r|unconfirmed|alleged|reportedly|may|might|could|denies?|without|no evidence|not confirmed)\b/i.test(text);
  if (matches.length !== 1 || unverified) return {
    eventType: matches.length > 1 ? 'multiple_or_ambiguous' : matches.length === 1 ? matches[0].eventType : 'unknown',
    direction: 'unknown', expectedness: 'unknown', horizon: 'unknown', impact: 'unknown',
    potentialSeverity: 'unknown', classificationStatus: matches.length > 1 ? 'ambiguous' : unverified && matches.length ? 'unverified_wording' : 'unclassified',
    classificationMethod: 'conservative_headline_rules_v1',
  };
  return { eventType: matches[0].eventType, direction: matches[0].direction,
    expectedness: 'unknown', horizon: 'unknown', impact: 'unknown', potentialSeverity: matches[0].potentialSeverity,
    classificationStatus: 'topic_match_only', classificationMethod: 'conservative_headline_rules_v1' };
}

export function summarizeCryptoHeadlineTags(items = []) {
  const rows = Array.isArray(items) ? items : [];
  const eventTypes = {};
  for (const row of rows) {
    const type = String(row?.eventType || 'unknown');
    eventTypes[type] = (eventTypes[type] || 0) + 1;
  }
  return { total: rows.length,
    topicMatched: rows.filter((row) => row?.classificationStatus === 'topic_match_only').length,
    ambiguous: rows.filter((row) => row?.classificationStatus === 'ambiguous').length,
    unverifiedWording: rows.filter((row) => row?.classificationStatus === 'unverified_wording').length,
    unclassified: rows.filter((row) => row?.classificationStatus === 'unclassified').length,
    explicitIncidentRiskBias: rows.filter((row) => ['security_incident', 'network_disruption', 'exchange_delisting'].includes(row?.eventType)
      && row?.direction === 'negative' && row?.classificationStatus === 'topic_match_only').length,
    eventTypes };
}

export function clearCryptoNewsCache() {
  cache.clear();
  inFlight.clear();
}

/** Optional, unscored market-wide headlines. This data is descriptive only and never vetoes or scores a trade. */
export async function loadFinnhubCryptoNews({ enabled = false, token = '', now = new Date(), fetcher = fetch,
  clock = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxRetryWaitMs = 5_000,
  successTtlMs = SUCCESS_TTL_MS, failureTtlMs = FAILURE_TTL_MS, skipReason = 'not_selected' } = {}) {
  if (!enabled) return { items: [], diagnostics: { status: skipReason, provider: 'Finnhub Market News', items: 0 } };
  const timestamp = new Date(now).getTime();
  if (!Number.isFinite(timestamp)) throw new TypeError('Crypto news observation time must be valid.');
  if (!token) return { items: [], diagnostics: { status: 'credentials_missing', provider: 'Finnhub Market News', items: 0 } };
  const key = createHash('sha256').update(`${timestamp - timestamp % 300_000}:${token}`).digest('hex');
  const current = Number(clock());
  const cached = cache.get(key);
  if (cached && cached.expiresAt > current) return { ...cached.value, diagnostics: { ...cached.value.diagnostics, cache: 'hit' } };
  if (inFlight.has(key)) {
    const value = await inFlight.get(key);
    return { ...value, diagnostics: { ...value.diagnostics, cache: 'coalesced' } };
  }
  const request = fetchNews({ token, timestamp, fetcher, clock, sleep, maxRetryWaitMs });
  inFlight.set(key, request);
  let result;
  try { result = await request; }
  finally { inFlight.delete(key); }
  const ttl = result.diagnostics.status === 'complete' ? successTtlMs : failureTtlMs;
  cache.set(key, { value: result, expiresAt: Number(clock()) + Math.max(0, Number(ttl) || 0) });
  return { ...result, diagnostics: { ...result.diagnostics, cache: 'miss' } };
}

async function fetchNews({ token, timestamp, fetcher, clock, sleep, maxRetryWaitMs }) {
  const query = new URLSearchParams({ category: 'crypto', token });
  const url = `${ENDPOINT}?${query}`;
  const startedAt = Date.now();
  let response;
  try {
    const result = await fetchNewsPayload({ url, fetcher, clock, sleep, maxRetryWaitMs });
    response = result.response;
    const payload = result.payload;
    if (!Array.isArray(payload)) throw new TypeError('Finnhub Market News response must be an array.');
    const items = [];
    let malformed = 0, stale = 0, future = 0, outOfCategory = 0;
    const identities = new Set();
    for (const row of payload) {
      const category = String(row?.category || 'crypto').trim().toLowerCase();
      if (category !== 'crypto') { outOfCategory += 1; continue; }
      const rawTime = row?.datetime;
      const seconds = Number(rawTime);
      const publishedAtMs = Number.isFinite(seconds) && seconds > 0
        ? (seconds > 100_000_000_000 ? seconds : seconds * 1_000)
        : Date.parse(String(rawTime || ''));
      if (!Number.isFinite(publishedAtMs) || !String(row?.headline || '').trim()) { malformed += 1; continue; }
      if (publishedAtMs > timestamp + 60_000) { future += 1; continue; }
      if (timestamp - publishedAtMs > MAX_NEWS_AGE_MS) { stale += 1; continue; }
      const identity = String(row.id ?? `${publishedAtMs}:${row.headline}`).slice(0, 400);
      if (identities.has(identity)) continue;
      identities.add(identity);
      let url = '';
      try {
        const parsed = new URL(String(row.url || ''));
        if (parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password) url = parsed.toString();
      } catch { /* Keep headline text but never expose an unsafe source URL. */ }
      const source = String(row.source || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
      const headline = String(row.headline).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240);
      items.push({ id: identity, provider: 'Finnhub Market News', category, publishedAt: new Date(publishedAtMs).toISOString(),
        headline, ...classifyCryptoHeadline(headline), source, publisherKnown: Boolean(source),
        relatedEntities: String(row.related || '').split(',').map((value) => value.trim().slice(0, 40)).filter(Boolean).slice(0, 20), url,
        sourceUrl: url || null, provenanceStatus: source && url ? 'publisher_and_article_url' : source ? 'publisher_only' : url ? 'article_url_only' : 'provider_record_only' });
    }
    items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    const retainedItems = items.slice(0, MAX_ITEMS);
    return { items: retainedItems, diagnostics: { status: malformed || future || outOfCategory ? 'partial' : 'complete',
      provider: 'Finnhub Market News', category: 'crypto', received: payload.length, items: retainedItems.length,
      tagCoverage: summarizeCryptoHeadlineTags(retainedItems),
      malformed, stale, future, outOfCategory, latencyMs: Math.max(0, Date.now() - startedAt), rateLimit: rateLimitHeaders(response.headers) } };
  } catch (error) {
    response = error?.response || response;
    const message = String(error?.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180);
    return { items: [], diagnostics: { status: 'provider_error', provider: 'Finnhub Market News', items: 0,
      latencyMs: Math.max(0, Date.now() - startedAt), rateLimit: rateLimitHeaders(response?.headers), error: message } };
  }
}

async function fetchNewsPayload({ url, fetcher, clock, sleep, maxRetryWaitMs }) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (attempt === 0) assertProviderAvailable(url, clock());
      else await waitForProviderCooldown(url, { now: clock, sleep, maxWaitMs: maxRetryWaitMs });
    } catch (error) {
      recordProviderRequest('Finnhub Market News', { latencyMs: 0, error: 'Request deferred by provider-host cooldown', deferred: true });
      throw error;
    }
    const started = performance.now();
    let response;
    try {
      response = await fetcher(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
      if (!response.ok) {
        const error = new Error(`Finnhub Market News returned HTTP ${response.status}.`);
        error.status = response.status;
        error.retryAfter = response.headers?.get?.('retry-after') ?? null;
        error.serverDate = response.headers?.get?.('date') ?? null;
        throw error;
      }
      const payload = await response.json();
      if (!Array.isArray(payload)) {
        const error = new TypeError('Finnhub Market News response must be an array.');
        error.name = 'InvalidProviderPayloadError';
        error.permanent = true;
        throw error;
      }
      recordProviderRequest('Finnhub Market News', { latencyMs: performance.now() - started, status: response.status, headers: response.headers });
      return { response, payload };
    } catch (error) {
      const status = Number(error?.status) || Number(response?.status) || null;
      recordProviderRequest('Finnhub Market News', { latencyMs: performance.now() - started, status,
        headers: response?.headers, error: status >= 400 ? `HTTP ${status}` : status ? 'invalid_provider_response' : String(error?.name || 'request_failed').slice(0, 80) });
      lastError = error;
      if (response && error && typeof error === 'object') error.response = response;
      if (error?.status === 429) recordProviderCooldown(url, error.retryAfter, attempt, { now: clock(), serverDateHeader: error.serverDate });
      if (error?.permanent || !isRetryableProviderFailure(error) || attempt === 2) break;
      const plan = retryPlan(error.retryAfter, attempt, { now: clock(), serverDateHeader: error.serverDate, maxRetryDelayMs: maxRetryWaitMs });
      if (!plan.retry) {
        error.message += ` Retry deferred because Retry-After requests ${plan.delayMs}ms, above the retry wait limit.`;
        break;
      }
      await sleep(plan.delayMs);
    }
  }
  throw lastError;
}

function rateLimitHeaders(headers) {
  const read = (name) => typeof headers?.get === 'function' ? headers.get(name) : null;
  const values = ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'].map((name) => {
    const raw = read(name); const number = raw == null || raw === '' ? null : Number(raw);
    return Number.isFinite(number) && number >= 0 ? number : null;
  });
  if (values.every((value) => value === null)) return null;
  const [limit, remaining, reset] = values;
  return { limit, remaining, reset, utilizationPct: limit > 0 && remaining !== null
    ? Number(Math.max(0, (limit - remaining) / limit * 100).toFixed(2)) : null };
}
