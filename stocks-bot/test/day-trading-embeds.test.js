import test from 'node:test';
import assert from 'node:assert/strict';
import { stockWatchEmbed } from '../src/discordPublisher.js';
import { discordEmbedPayload } from '../../new-bots/shared/discordPresentation.js';

test('all five stock highlights remain individually readable with coverage and unapproved-level labels', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ symbol: `T${i}`, direction: 'UPWARD WATCH', price: 100,
    change1h: 1, changeDay: 2, score: 70, relativeVolume: 2, observedAt: '2026-10-02T15:00:00Z',
    referenceEntry: 100, referenceTarget1: 102, referenceInvalidation: 99, reasons: ['confirmation pending'] }));
  const embed = stockWatchEmbed('2026-10-02', rows, { assetsScreened: 130 }).toJSON();
  assert.match(embed.description, /130 symbols screened/);
  assert.equal(embed.fields.length, 5);
  for (const row of embed.fields) { assert.match(row.value, /not profit probability/); assert.match(row.value, /Not an approved entry/); }
  assert.doesNotThrow(() => discordEmbedPayload({ embeds: [embed] }));
});

test('unknown scan coverage stays unknown and long metadata cannot overflow an embed', () => {
  const embed = stockWatchEmbed('2026-10-02', [{ symbol: 'TEST', reasons: ['x'.repeat(6000)] }]).toJSON();
  assert.match(embed.description, /unknown symbols/);
  assert.doesNotThrow(() => discordEmbedPayload({ embeds: [embed] }));
});
