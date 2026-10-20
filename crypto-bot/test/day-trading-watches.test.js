import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDayTradingWatches, recordDayTradingWatchDelivery, unannouncedDayTradingWatches } from '../src/dayTradingWatches.js';
import { openingDayTradingEmbed } from '../src/discordPublisher.js';
import { discordEmbedPayload } from '../../new-bots/shared/discordPresentation.js';

const now = new Date('2026-10-02T15:00:00Z');
const asset = (id = 'test', overrides = {}) => ({ id, symbol: id, change1h: 1,
  model: { technicallyConfirmed: true, providerCount: 2, score: 70, validationPassed: false },
  marketData: { providerCount: 2, candleProvider: 'Kraken', candlePair: 'TESTUSD',
    quotes: [{ provider: 'Kraken', pair: 'TESTUSD', timestampBasis: 'provider_event', observedAt: now.toISOString(), bid: 9.99, ask: 10 }] }, ...overrides });

test('a validation-pending watch can be shown before a target move without becoming an approved trade', () => {
  const source = asset(), before = JSON.stringify(source);
  const watches = buildDayTradingWatches([source], [], now);
  assert.equal(watches.length, 1);
  assert.equal(watches[0].price, 10);
  assert.equal(watches[0].validationPassed, false);
  assert.match(watches[0].reason, /not an approved entry/);
  assert.equal(watches[0].targetPrice, undefined);
  assert.equal(JSON.stringify(source), before);
  assert.equal(buildDayTradingWatches([source], [{ assetId: 'test' }], now).length, 0);
});

test('stale, mismatched, conflicted, single-source and vetoed candidates cannot appear as fresh watches', () => {
  const base = asset();
  for (const candidate of [
    asset('stale', { marketData: { ...base.marketData, quotes: [{ ...base.marketData.quotes[0], observedAt: '2026-10-02T14:59:00Z' }] } }),
    asset('pair', { marketData: { ...base.marketData, candlePair: 'OTHERUSD' } }),
    asset('single', { marketData: { ...base.marketData, providerCount: 1 } }),
    ...['eventBlocked', 'executionBlocked', 'derivativesBlocked', 'dataConflict'].map(key => asset(key, { model: { ...base.model, [key]: true } })),
  ]) assert.equal(buildDayTradingWatches([candidate], [], now).length, 0, candidate.id);
});

test('watch delivery is deduplicated per day and reopens only on validation advancement or a new day', () => {
  const watches = buildDayTradingWatches([asset()], [], now);
  const state = recordDayTradingWatchDelivery(null, watches, '2026-10-02');
  assert.equal(unannouncedDayTradingWatches(watches, state, '2026-10-02').length, 0);
  assert.equal(unannouncedDayTradingWatches(watches, state, '2026-10-03').length, 1);
  const improved = buildDayTradingWatches([asset('test', { model: { ...asset().model, validationPassed: true } })], [], now);
  assert.equal(unannouncedDayTradingWatches(improved, state, '2026-10-02').length, 1);
});

test('opening highlights show actual scan coverage and no long-term names as intraday ideas', () => {
  const watches = buildDayTradingWatches(Array.from({ length: 10 }, (_, i) => asset(`C${i}`)), [], now);
  const embed = openingDayTradingEmbed({ dateKey: '2026-10-02', assetsScreened: 250, predictions: [], generatedAt: now.toISOString(), source: 'test provider',
    dayTradingWatches: watches, investmentResearch: { results: [{ symbol: 'LONGTERM' }] }, scanDecision: { preliminary: 10, confirmed: 0, portfolioSelected: 0 } }).toJSON();
  assert.match(embed.description, /250 assets screened/);
  assert.match(embed.description, /not the complete universe/);
  assert.ok(!JSON.stringify(embed).includes('LONGTERM'));
  assert.equal(embed.fields.filter(row => row.name.includes('WATCH')).length, 5);
  assert.doesNotThrow(() => discordEmbedPayload({ embeds: [embed] }));
});
