import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyStockHeadline, summarizeStockHeadlineClassification } from '../src/stockHeadlineClassifier.js';

test('stock headline topic rules keep unsupported direction, timing, and impact unknown', () => {
  assert.deepEqual(classifyStockHeadline('Company wins a major contract'), {
    eventType: 'contract_or_order', direction: 'unknown', expectedness: 'unknown', horizon: 'unknown', impact: 'unknown',
    potentialSeverity: 'medium', classificationStatus: 'topic_match_only', classificationMethod: 'conservative_headline_rules_v1'
  });
  assert.equal(classifyStockHeadline('FDA approves new treatment').direction, 'positive');
  assert.equal(classifyStockHeadline('Company cuts full-year guidance').direction, 'negative');
  assert.equal(classifyStockHeadline('Company beats estimates in earnings').direction, 'positive');
  assert.equal(classifyStockHeadline('Rumor: company may announce an acquisition').classificationStatus, 'unverified_wording');
  assert.equal(classifyStockHeadline('Company wins a major contract after CEO resigns').eventType, 'multiple_or_ambiguous');
  assert.equal(classifyStockHeadline('Shares rise in afternoon trading').eventType, 'unknown');
});

test('stock headline coverage summary counts rule states as descriptive diagnostics', () => {
  const result = summarizeStockHeadlineClassification([
    { eventType: 'earnings', classificationStatus: 'topic_match_only', direction: 'unknown' },
    { eventType: 'multiple_or_ambiguous', classificationStatus: 'ambiguous' },
    { eventType: 'acquisition', classificationStatus: 'unverified_wording' },
    { eventType: 'unknown', classificationStatus: 'unclassified' },
  ]);
  assert.equal(result.total, 4);
  assert.equal(result.topicMatched, 1);
  assert.equal(result.ambiguous, 1);
  assert.equal(result.unverifiedWording, 1);
  assert.equal(result.unclassified, 1);
  assert.equal(result.explicitPolarityTags, 0);
  assert.equal(result.eventTypes.earnings, 1);
});

test('corporate actions are attached point-in-time and raise the nearby-event risk gate', async () => {
  const temporaryData = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-stocks-events-'));
  process.env.OMNIMOD_STOCKS_DATA_DIR = temporaryData;
  process.env.SEC_USER_AGENT = '';
  process.env.FRED_API_KEY = '';
  process.env.STOCKS_ALPACA_NEWS_ENABLED = 'true';
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    requestedUrls.push(requestedUrl);
    if (requestedUrl.includes('/v1beta1/news')) return {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ news: [{ id: 1, created_at: '2026-07-21T14:30:00Z', updated_at: '2026-07-21T14:31:00Z',
        symbols: ['NVDA'], headline: 'Company reports quarterly results', source: 'Fixture News', url: 'https://news.example/story' }] })
    };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        corporate_actions: {
          forward_splits: [{ initiating_symbol: 'NVDA', ex_date: '2026-07-22' }]
        }
      })
    };
  };
  try {
    const { enrichAssetsWithIntelligence } = await import('../src/eventIntelligence.js');
    const result = await enrichAssetsWithIntelligence([{ symbol: 'NVDA', price: 150 }], {
      alpaca_key_id: 'id', alpaca_secret_key: 'secret'
    }, {}, new Date('2026-07-21T15:00:00Z'));
    assert.ok(requestedUrls.some((url) => url.includes('/v1/corporate-actions?') && url.includes('symbols=NVDA')));
    assert.ok(requestedUrls.some((url) => url.includes('/v1beta1/news?') && url.includes('symbols=NVDA')));
    assert.equal(result.assets[0].corporateActionType, 'forward_splits');
    assert.equal(result.assets[0].corporateActionRisk, 90);
    assert.equal(result.assets[0].corporateActionDataStatus, 'available');
    assert.equal(result.assets[0].secDataStatus, 'credentials_missing');
    assert.equal(result.assets[0].macroDataStatus, 'credentials_missing');
    assert.equal(result.assets[0].recentNewsStatus, 'available');
    assert.equal(result.assets[0].recentNews[0].publisher, 'Fixture News');
    assert.equal(result.assets[0].recentNews[0].eventType, 'earnings');
    assert.equal(result.assets[0].recentNews[0].direction, 'unknown');
    assert.equal(result.assets[0].recentNews[0].activityAt, '2026-07-21T14:31:00.000Z');
    assert.equal(result.report.corporateActionsEnabled, true);
    const { formatPointInTimeEventRisk } = await import('../src/discordPublisher.js');
    const eventText = formatPointInTimeEventRisk(result.assets[0]);
    assert.match(eventText, /Recent headlines \(available; context only, unscored\)/);
    assert.match(eventText, /Company reports quarterly results/);
    assert.match(eventText, /topic earnings \/ unknown \/ possible severity medium/);
    assert.match(eventText, /Rule tags are topic hints only/);
    assert.match(eventText, /SEC coverage credentials_missing/);
    assert.match(eventText, /forward_splits/);
    assert.match(eventText, /Macro stress unavailable \(credentials_missing\)/);
    assert.doesNotMatch(eventText, /No recent filing|none nearby|Macro stress 0\/100/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.STOCKS_ALPACA_NEWS_ENABLED;
    await fs.rm(temporaryData, { recursive: true, force: true });
  }
});
