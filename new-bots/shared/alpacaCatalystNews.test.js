import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAlpacaCatalystNews, fetchAlpacaCatalystNews, normalizeAlpacaNewsArticle } from './alpacaCatalystNews.js';

const now = Date.parse('2026-09-29T15:00:00Z');
const clear = (reviewedAt = now - 60_000) => ({ status: 'clear', source: 'manual review', summary: 'No known catalyst.', reviewedAt: new Date(reviewedAt).toISOString() });

test('Alpaca catalyst news records articles and invalidates only reviews older than a news item', async () => {
  const fetcher = async (url, options) => {
    assert.equal(new URL(url).pathname, '/v1beta1/news');
    assert.equal(options.headers['APCA-API-KEY-ID'], 'key');
    return { ok: true, status: 200, headers: { 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '150', 'X-RateLimit-Reset': '900' }, json: async () => ({ news: [
      { id: 'new', created_at: new Date(now - 20_000).toISOString(), updated_at: new Date(now - 10_000).toISOString(), symbols: ['XYZ'], headline: 'Company event', source: 'Wire' },
      { id: 'old', created_at: new Date(now - 90_000).toISOString(), updated_at: new Date(now - 90_000).toISOString(), symbols: ['ABC'], headline: 'Old item', source: 'Wire' },
    ] }) };
  };
  const metrics = [];
  const news = await fetchAlpacaCatalystNews(['ABC', 'XYZ'], { key: 'key', secret: 'secret', fetcher, now, metrics });
  const rows = applyAlpacaCatalystNews([
    { signal: { underlyingSymbol: 'ABC', catalystReview: clear(now - 60_000) } },
    { signal: { underlyingSymbol: 'XYZ', catalystReview: clear(now - 60_000) } },
  ], news, { now });
  assert.equal(rows[0].catalystNewsStatus, 'clear');
  assert.equal(rows[0].signal.catalystNews.length, 1);
  assert.equal(rows[1].catalystNewsStatus, 'review-invalidated');
  assert.equal(rows[1].signal.catalystReview.status, 'blocked');
  assert.equal(rows[1].signal.catalystNews[0].createdAt, new Date(now - 20_000).toISOString());
  assert.equal(rows[1].signal.catalystNews[0].updatedAt, new Date(now - 10_000).toISOString());
  assert.equal(rows[1].signal.catalystNews[0].activityAt, new Date(now - 10_000).toISOString());
  assert.equal(news.diagnostics.status, 'complete');
  assert.equal(news.diagnostics.articles, 2);
  assert.deepEqual(metrics[0].rateLimit, { limit: 200, remaining: 150, reset: 900, utilizationPct: 25 });
});

test('missing or incomplete Alpaca news coverage fails closed', async () => {
  await assert.rejects(fetchAlpacaCatalystNews(['ABC'], { fetcher: async () => { throw new Error('no network'); }, now }), /credentials/);
  const failed = await fetchAlpacaCatalystNews(['ABC'], { key: 'key', secret: 'secret', now,
    fetcher: async () => ({ ok: false, status: 403, json: async () => ({}) }) });
  assert.deepEqual([...failed.incomplete], ['ABC']);
  const row = applyAlpacaCatalystNews([{ signal: { underlyingSymbol: 'ABC', catalystReview: clear() } }], failed, { now })[0];
  assert.equal(row.catalystNewsStatus, 'coverage-incomplete');
  assert.equal(row.signal.catalystReview.status, 'blocked');
});

test('invalid ticker symbols are rejected before network access', async () => {
  let calls = 0;
  await assert.rejects(fetchAlpacaCatalystNews(['BRK/B'], { key: 'key', secret: 'secret', fetcher: async () => { calls++; }, now }), /valid uppercase tickers/);
  assert.equal(calls, 0);
});

test('Alpaca news timestamp normalization preserves creation vs update and uses latest activity for invalidation', () => {
  const event = normalizeAlpacaNewsArticle({ id: 7, created_at: new Date(now - 5 * 60_000).toISOString(),
    updated_at: new Date(now - 10_000).toISOString(), symbols: ['xyz', 'XYZ'], headline: ' Updated\nheadline ', source: 'Wire',
    url: 'https://news.example/story' }, { now });
  assert.deepEqual(event, { id: '7', provider: 'Alpaca', symbols: ['XYZ'], createdAt: now - 5 * 60_000,
    updatedAt: now - 10_000, activityAt: now - 10_000, headline: 'Updated headline', publisher: 'Wire', sourceUrl: 'https://news.example/story' });
  assert.equal(normalizeAlpacaNewsArticle({ created_at: new Date(now - 10_000).toISOString(), updated_at: 'bad',
    symbols: ['XYZ'], headline: 'News', source: 'Wire' }, { now }), null);
  assert.equal(normalizeAlpacaNewsArticle({ created_at: new Date(now + 60_000).toISOString(), updated_at: new Date(now + 60_000).toISOString(),
    symbols: ['XYZ'], headline: 'Future', source: 'Wire' }, { now }), null);
  const oversizedUrl = normalizeAlpacaNewsArticle({ created_at: new Date(now - 1_000).toISOString(), updated_at: new Date(now - 1_000).toISOString(),
    symbols: ['XYZ'], headline: 'News', source: 'Wire', url: `https://news.example/${'x'.repeat(1_100)}` }, { now });
  assert.equal(oversizedUrl.sourceUrl, null);
});
