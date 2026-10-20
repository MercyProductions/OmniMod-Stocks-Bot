import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDayTradingBrief, discordEmbedPayload } from '../discordPresentation.js';
import { buildPaperResearchHandoffRows } from '../paperSignalHandoff.js';

const result = (i, status = 'reserved') => ({ symbol: `TEST${i}`, status,
  candidate: { instrumentKey: `TEST${i}`, exposureKey: `TEST${i}`, strategyId: 'opening-range', direction: 'long', entryPrice: 10, stopPrice: 9, targetPrice: 12 },
  reservation: { order: { paperOnly: true, orderId: `order-${i}`, instrumentKey: `TEST${i}`, exposureKey: `TEST${i}`, direction: 'long', entryPrice: 10, stopPrice: 9, targetPrice: 12, reservedAt: '2026-10-02T15:00:00Z' } },
  decision: { reasons: ['portfolio_limit'] } });

test('every reserved signal shared with peer bots remains visible in the embed; blocked rows are watches', () => {
  const results = [result(1), result(2), result(3), result(4), result(5, 'risk-blocked')];
  const handoffRows = buildPaperResearchHandoffRows('etfs-etps', results);
  const payload = buildDayTradingBrief({ bot: 'etfs-etps', coverage: '6000 eligible; 130 screened', source: 'provider', results, handoffRows, emergencyStop: false });
  const text = JSON.stringify(payload);
  for (const row of handoffRows) assert.ok(text.includes(row.symbol));
  assert.match(text, /4 paper reservations/);
  assert.match(text, /Showing 3 reservations/);
  assert.match(text, /WATCH — NOT APPROVED/);
  assert.match(text, /portfolio limit|portfolio_limit/);
  assert.match(text, /not the entire universe/);
  assert.equal(payload.content, undefined);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});

test('all four day-trading briefs stay within Discord limits even with maximum metadata', () => {
  for (const bot of ['forex', 'futures', 'options', 'etfs-etps']) {
    const results = Array.from({ length: 50 }, (_, i) => ({ ...result(i, 'risk-blocked'), decision: { reasons: ['x'.repeat(6000)] } }));
    const payload = buildDayTradingBrief({ bot, coverage: 'c'.repeat(6000), source: 's'.repeat(6000), results, context: ['r'.repeat(6000)] });
    assert.doesNotThrow(() => discordEmbedPayload(payload));
    assert.match(JSON.stringify(payload), /50 strategy-qualified watches/);
    assert.match(JSON.stringify(payload), /Showing 0 reservations and 5 watches/);
  }
});

test('missing data and no-setup rows never become profitable watches or zero measured coverage', () => {
  const payload = buildDayTradingBrief({ bot: 'forex', coverage: 'unknown', source: 'disabled', results: [{ symbol: 'EUR_USD', status: 'no-setup' }] });
  const text = JSON.stringify(payload);
  assert.match(text, /No candidate passed/);
  assert.match(text, /paused by emergency stop/);
  assert.ok(!text.includes('EUR_USD'));
  assert.equal(discordEmbedPayload('Connection test').embeds.length, 1);
  assert.throws(() => discordEmbedPayload({ embeds: [{ fields: [{ name: 'bad', value: 'x'.repeat(1025) }] }] }), /field is invalid/);
  assert.throws(() => discordEmbedPayload({ embeds: [{ description: 'a'.repeat(4000) }, { description: 'b'.repeat(4000) }] }), /combined/);
});

test('inverse fund position direction and option premium are distinct from underlying exposure', () => {
  const inverse = result(1);
  inverse.reservation.order.quantity = 7;
  const row = { ...buildPaperResearchHandoffRows('etfs-etps', [inverse])[0], direction: 'short', entryPrice: 99 };
  const text = JSON.stringify(buildDayTradingBrief({ bot: 'etfs-etps', results: [inverse], handoffRows: [row] }));
  assert.match(text, /position long · exposure bias short/);
  assert.match(text, /entry 10 · stop 9 · target 12/);
  assert.match(text, /Size 7 units/);
  const optionText = JSON.stringify(buildDayTradingBrief({ bot: 'options', results: [inverse], handoffRows: [row] }));
  assert.match(optionText, /Spread premium: entry 10/);
  assert.ok(!optionText.includes('entry 99'));
});
