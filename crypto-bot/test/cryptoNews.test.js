import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCryptoHeadline, clearCryptoNewsCache, loadFinnhubCryptoNews, summarizeCryptoHeadlineTags } from '../src/cryptoNews.js';
import { withProviderTelemetry } from '../src/providerTelemetry.js';

const now = Date.parse('2026-09-29T15:00:00Z');
const response = (payload, status = 200, headers = new Headers()) => ({ ok: status >= 200 && status < 300, status, headers, json: async () => payload });

test('headline rules label explicit catalyst topics but keep truth, impact, timing, and ambiguous direction unknown', () => {
  const incident = classifyCryptoHeadline('Exchange confirms customer funds were stolen in a security breach');
  assert.equal(incident.eventType, 'security_incident');
  assert.equal(incident.direction, 'negative');
  assert.equal(incident.potentialSeverity, 'high');
  assert.equal(incident.impact, 'unknown');
  assert.equal(incident.expectedness, 'unknown');
  assert.equal(incident.classificationStatus, 'topic_match_only');
  assert.equal(classifyCryptoHeadline('A token unlock begins next week').eventType, 'token_supply_event');
  assert.equal(classifyCryptoHeadline('Bitcoin ETF posts record inflows').direction, 'unknown');
  assert.equal(classifyCryptoHeadline('Rumor: exchange may delist TokenX').classificationStatus, 'unverified_wording');
  assert.equal(classifyCryptoHeadline('Exchange lists TokenX for spot trading after a network upgrade').eventType, 'multiple_or_ambiguous');
  assert.equal(classifyCryptoHeadline('Crypto market analysis today').eventType, 'unknown');
});

test('headline coverage summary counts classification states without inferring event truth', () => {
  const result = summarizeCryptoHeadlineTags([
    { eventType: 'security_incident', direction: 'negative', classificationStatus: 'topic_match_only' },
    { eventType: 'multiple_or_ambiguous', classificationStatus: 'ambiguous' },
    { eventType: 'regulatory_action', classificationStatus: 'unverified_wording' },
    { eventType: 'unknown', classificationStatus: 'unclassified' },
  ]);
  assert.equal(result.total, 4);
  assert.equal(result.topicMatched, 1);
  assert.equal(result.ambiguous, 1);
  assert.equal(result.unverifiedWording, 1);
  assert.equal(result.unclassified, 1);
  assert.equal(result.explicitIncidentRiskBias, 1);
  assert.equal(result.eventTypes.security_incident, 1);
});

test('news is opt-in and does not request Finnhub in manual mode', async () => {
  let calls = 0;
  const result = await loadFinnhubCryptoNews({ now: new Date(now), fetcher: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal(result.diagnostics.status, 'not_selected');
  assert.deepEqual(result.items, []);
});

test('news selects fresh crypto-category headlines, rejects stale/future rows and unsafe URLs', async () => {
  clearCryptoNewsCache();
  let requested;
  const headers = new Headers({ 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': '45', 'X-RateLimit-Reset': '1800' });
  const result = await loadFinnhubCryptoNews({ enabled: true, token: 'private-fixture', now: new Date(now), fetcher: async (url) => {
    requested = new URL(url);
    return response([
      { id: 1, category: 'crypto', datetime: Math.floor((now - 60_000) / 1_000), headline: 'Fresh market headline', source: 'Wire', url: 'https://news.example/item', related: 'BTC, ETH' },
      { id: 2, datetime: Math.floor((now - 7 * 60 * 60_000) / 1_000), headline: 'Stale story' },
      { id: 3, datetime: Math.floor((now + 5 * 60_000) / 1_000), headline: 'Future story' },
      { id: 4, datetime: 'bad-time', headline: 'Malformed story' },
      { id: 5, datetime: Math.floor((now - 30_000) / 1_000), headline: 'Unsafe source', url: 'javascript:alert(1)' },
      { id: 6, category: 'forex', datetime: Math.floor((now - 20_000) / 1_000), headline: 'Wrong category', source: 'Wire', url: 'https://news.example/forex' },
      { id: 7, datetime: Math.floor((now - 10_000) / 1_000), headline: 'Exchange suspends withdrawals after network outage', source: 'Wire' },
    ], 200, headers);
  } });
  assert.equal(requested.pathname, '/api/v1/news');
  assert.equal(requested.searchParams.get('category'), 'crypto');
  assert.deepEqual(result.items.map((item) => item.headline), ['Exchange suspends withdrawals after network outage', 'Unsafe source', 'Fresh market headline']);
  assert.equal(result.items[0].url, '');
  assert.equal(result.items[1].provider, 'Finnhub Market News');
  assert.equal(result.items[1].category, 'crypto');
  assert.equal(result.items[1].publisherKnown, false);
  assert.equal(result.items[1].provenanceStatus, 'provider_record_only');
  assert.deepEqual(result.items[2].relatedEntities, ['BTC', 'ETH']);
  assert.equal(result.items[0].eventType, 'network_disruption');
  assert.equal(result.items[0].direction, 'negative');
  assert.equal(result.items[0].classificationMethod, 'conservative_headline_rules_v1');
  assert.equal(result.items[2].eventType, 'unknown');
  assert.equal(result.items[2].sourceUrl, 'https://news.example/item');
  assert.equal(result.diagnostics.status, 'partial');
  assert.equal(result.diagnostics.stale, 1);
  assert.equal(result.diagnostics.future, 1);
  assert.equal(result.diagnostics.malformed, 1);
  assert.equal(result.diagnostics.outOfCategory, 1);
  assert.equal(result.diagnostics.rateLimit.utilizationPct, 25);
  assert.equal(result.diagnostics.tagCoverage.total, 3);
  assert.equal(result.diagnostics.tagCoverage.topicMatched, 1);
  assert.equal(result.diagnostics.tagCoverage.unclassified, 2);
});

test('missing credentials and provider failures remain diagnostic and never synthesize headlines', async () => {
  clearCryptoNewsCache();
  let calls = 0;
  const missing = await loadFinnhubCryptoNews({ enabled: true, now: new Date(now), fetcher: async () => { calls += 1; } });
  assert.equal(missing.diagnostics.status, 'credentials_missing');
  assert.equal(calls, 0);
  const failed = await loadFinnhubCryptoNews({ enabled: true, token: 'secret-fixture', now: new Date(now), fetcher: async () => response({}, 403) });
  assert.equal(failed.diagnostics.status, 'provider_error');
  assert.deepEqual(failed.items, []);
  assert.doesNotMatch(JSON.stringify(failed.diagnostics), /secret-fixture/);
});

test('identical guild scans share a cached read and cache expiry is bounded', async () => {
  clearCryptoNewsCache();
  let requests = 0, clock = 10_000;
  const options = { enabled: true, token: 'cache-test', now: new Date(now), clock: () => clock, successTtlMs: 60_000,
    fetcher: async () => { requests += 1; return response([]); } };
  const first = await loadFinnhubCryptoNews(options);
  const second = await loadFinnhubCryptoNews(options);
  assert.equal(first.diagnostics.cache, 'miss');
  assert.equal(second.diagnostics.cache, 'hit');
  assert.equal(requests, 1);
  clock += 60_001;
  await loadFinnhubCryptoNews(options);
  assert.equal(requests, 2);
  clearCryptoNewsCache();
});

test('Finnhub news retries a bounded 429 using Retry-After and records each provider attempt', async () => {
  clearCryptoNewsCache();
  let calls = 0, clock = 20_000;
  const wrapped = await withProviderTelemetry(() => loadFinnhubCryptoNews({ enabled: true, token: 'retry-fixture', now: new Date(now),
    clock: () => clock, sleep: async (ms) => { clock += ms; }, fetcher: async () => {
      calls += 1;
      return calls === 1 ? response({}, 429, new Headers({ 'Retry-After': '1' })) : response([]);
    } }));
  assert.equal(calls, 2);
  assert.equal(wrapped.result.diagnostics.status, 'complete');
  assert.equal(wrapped.providers['Finnhub Market News'].requests, 2);
  assert.equal(wrapped.providers['Finnhub Market News'].rateLimits, 1);
  assert.equal(wrapped.providers['Finnhub Market News'].successes, 1);
  assert.equal(wrapped.providers['Finnhub Market News'].failures, 1);
});

test('Finnhub news respects an over-budget Retry-After and defers a later same-host request', async () => {
  clearCryptoNewsCache();
  let calls = 0, clock = 50_000;
  const first = await loadFinnhubCryptoNews({ enabled: true, token: 'cooldown-fixture-a', now: new Date(now),
    clock: () => clock, sleep: async (ms) => { clock += ms; }, maxRetryWaitMs: 5_000,
    fetcher: async () => { calls += 1; return response({}, 429, new Headers({ 'Retry-After': '30' })); } });
  assert.equal(first.diagnostics.status, 'provider_error');
  assert.match(first.diagnostics.error, /above the retry wait limit/);
  assert.doesNotMatch(JSON.stringify(first.diagnostics), /cooldown-fixture-a/);
  const second = await withProviderTelemetry(() => loadFinnhubCryptoNews({ enabled: true, token: 'cooldown-fixture-b', now: new Date(now),
    clock: () => clock, sleep: async () => {}, fetcher: async () => { calls += 1; return response([]); } }));
  assert.equal(calls, 1);
  assert.equal(second.result.diagnostics.status, 'provider_error');
  assert.match(second.result.diagnostics.error, /cooling down/);
  assert.equal(second.providers['Finnhub Market News'].requests, 0);
  assert.equal(second.providers['Finnhub Market News'].cooldownDeferrals, 1);
  assert.doesNotMatch(JSON.stringify(second.result.diagnostics), /cooldown-fixture-b/);
  clearCryptoNewsCache();
});

test('Finnhub news treats malformed successful payloads as permanent provider failures', async () => {
  clearCryptoNewsCache();
  let calls = 0;
  const wrapped = await withProviderTelemetry(() => loadFinnhubCryptoNews({ enabled: true, token: 'payload-fixture', now: new Date(now),
    sleep: async () => {}, fetcher: async () => { calls += 1; return response({ articles: [] }); } }));
  assert.equal(calls, 1);
  assert.equal(wrapped.result.diagnostics.status, 'provider_error');
  assert.match(wrapped.result.diagnostics.error, /must be an array/);
  assert.equal(wrapped.providers['Finnhub Market News'].failures, 1);
  assert.equal(wrapped.providers['Finnhub Market News'].lastError, 'invalid_provider_response');
  clearCryptoNewsCache();
});
