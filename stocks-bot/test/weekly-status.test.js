import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-stocks-status-'));
process.env.OMNIMOD_STOCKS_DATA_DIR = dataDir;
const guildId = 'status-test-guild';
await fs.writeFile(path.join(dataDir, 'guild-settings.json'), JSON.stringify({
  [guildId]: { signalsChannelId: 'signals', resultsChannelId: 'results' }
}));
const { postWeeklyStatus, postOpeningSummary, postResearchWatchUpdate, postDailyReview, predictionEmbed, summarizeSignalEvidence, formatPointInTimeEventRisk } = await import('../src/discordPublisher.js');
after(() => fs.rm(dataDir, { recursive: true, force: true }));

test('weekly status posts once with no alert ping and clearly marks unvalidated signals', async () => {
  const sent = [];
  const channel = {
    isTextBased: () => true,
    messages: { fetch: async () => sent },
    send: async (payload) => {
      const message = {
        id: String(sent.length + 1), author: { id: 'stocks-bot' },
        embeds: payload.embeds.map((embed) => embed.toJSON()), payload
      };
      sent.push(message);
      return message;
    }
  };
  const client = {
    user: { id: 'stocks-bot' },
    guilds: { fetch: async () => ({ channels: { fetch: async () => channel } }) }
  };
  const status = {
    dateKey: '2026-09-20',
    modelStatus: 'No validated model is installed. Rule-only trade alerts remain disabled while research is collected.'
  };
  const first = await postWeeklyStatus(client, guildId, status);
  const second = await postWeeklyStatus(client, guildId, status);
  assert.equal(first.id, second.id);
  assert.equal(sent.length, 1);
  assert.deepEqual(first.payload.allowedMentions, { parse: [] });
  assert.match(first.embeds[0].fields[0].value, /No validated model/);
  assert.match(first.embeds[0].footer.text, /STOCK-STATUS:2026-09-20/);
});

test('stock watch shows a timestamped quote and blocker without presenting an entry', async () => {
  const sent = [];
  const channel = {
    isTextBased: () => true,
    messages: { fetch: async () => sent },
    send: async (payload) => {
      const message = { id: String(sent.length + 1), author: { id: 'stocks-bot' }, embeds: payload.embeds.map((embed) => embed.toJSON()), payload };
      sent.push(message);
      return message;
    }
  };
  const client = { user: { id: 'stocks-bot' }, guilds: { fetch: async () => ({ channels: { fetch: async () => channel } }) } };
  const row = { symbol: 'ARM', price: 75.25, referenceEntry: 75.25, referenceTarget1: 76, referenceInvalidation: 74.5, referenceMovePct: 1, score: 72, dataQuality: 63, observedAt: '2026-09-21T13:30:00.000Z', reasons: ['relative volume'] };
  const discovery = { dateKey: '2026-09-21', assetsScreened: 52, predictions: [], watchOnly: [row], modelStatus: 'No validated model is installed.' };
  const opening = await postOpeningSummary(client, guildId, discovery);
  const watchText = opening.embeds[0].fields.find((field) => field.name.startsWith('ARM')).value;
  assert.match(watchText, /\$75\.25/);
  assert.match(watchText, /Strength 72\/100/);
  assert.match(watchText, /Needs: relative volume/);
  assert.match(watchText, /ATR scenario only: reference \$75\.25 · target \$76\.00 · invalidation \$74\.50/);
  assert.deepEqual(opening.payload.allowedMentions, { roles: [] });
  const update = await postResearchWatchUpdate(client, guildId, discovery.dateKey, [row]);
  assert.match(update.embeds[0].title, /Day-trading.*watches/);
  assert.match(update.embeds[0].fields[0].name, /ARM/);
  assert.match(update.embeds[0].fields[0].value, /\$75\.25/);
  assert.match(update.embeds[0].description, /none is an approved entry/);
  assert.deepEqual(update.payload.allowedMentions, { parse: [] });
  const premarket = await postResearchWatchUpdate(client, guildId, discovery.dateKey, [{ ...row, session: 'pre_market', changeDay: 3.4, premarketBreakout: true, priceSource: 'Alpaca SIP snapshot' }]);
  assert.match(premarket.embeds[0].title, /Premarket breakout.*watches/);
  assert.match(premarket.embeds[0].fields[0].value, /premarket \+3\.40% vs prior close/);
  assert.match(premarket.embeds[0].fields[0].value, /20-session high cleared/);
  assert.match(premarket.embeds[0].fields[0].value, /Alpaca SIP snapshot/);
  assert.match(premarket.embeds[0].description, /extended-hours data/);
});

test('stock paper prediction identifies its short-term strategy and balances supporting evidence with cautions', () => {
  const embed = predictionEmbed({ symbol: 'AMD', horizonLabel: '90-minute momentum', createdAt: '2026-09-24T14:00:00.000Z',
    thesis: 'Fixture thesis', action: 'CONDITIONAL BUY', disclaimer: 'Paper research only.', trend: 'Confirmed multi-timeframe uptrend',
    relativeVolume: 1.8, relativeStrengthDay: 0.7, vwapDistancePct: 0.4, confirmationCount: 2, confirmationRequired: 2,
    factors: { sector: 50, sectorDataStatus: 'unavailable' }, calibration: { calibrated: false }, marketRegime: 'sideways' });
  assert.match(embed.data.title, /^SHORT-TERM PAPER TRADE \| AMD \| 90-minute momentum$/);
  const evidence = embed.data.fields.find((field) => field.name === 'Evidence at prediction time').value;
  assert.ok(evidence.length <= 1024);
  assert.match(evidence, /Supports: Confirmed multi-timeframe uptrend; Relative volume 1\.80x/);
  assert.match(evidence, /Cautions: Outcome probability is not calibrated/);
  assert.match(evidence, /Market regime is sideways/);
  assert.match(embed.data.fields.find((field) => field.name === 'Auralith v4 factors').value, /Sector proxy unavailable; neutral factor \(7%\)/);
});

test('stock target-hit card discloses regime- and horizon-specific empirical evidence without claiming independent calibration', () => {
  const calibrated = predictionEmbed({ symbol: 'AMD', horizonLabel: '90-minute momentum', thesis: 'Fixture thesis', createdAt: '2026-09-24T14:00:00.000Z',
    calibration: { calibrated: true, probability: 58, low: 46, high: 70, sampleSize: 24, dayCount: 8, scoreBand: '70-79', scope: 'same momentum horizon, same mixed market regime' } });
  const field = calibrated.data.fields.find((row) => row.name === 'Calibration').value;
  assert.match(field, /Historical target-hit estimate \*\*58\.0%\*\*/);
  assert.match(field, /score band 70-79; n=24/);
  assert.match(field, /across 8 outcome days/);
  assert.match(field, /Scope: same momentum horizon, same mixed market regime; not independently calibrated/);

  const collecting = predictionEmbed({ symbol: 'AMD', horizonLabel: '90-minute momentum', thesis: 'Fixture thesis', createdAt: '2026-09-24T14:00:00.000Z',
    calibration: { calibrated: false, sampleSize: 8 } });
  assert.match(collecting.data.fields.find((row) => row.name === 'Calibration').value,
    /No stable target-hit probability yet \(8\/20 outcomes across 0\/5 outcome days.*score band, horizon, and regime/);
});

test('stock evidence summary leaves unknown event and quality data unknown', () => {
  const evidence = summarizeSignalEvidence({ daysToEarnings: null, dataQuality: null, marketRegime: 'unknown',
    executionEvidence: { stressedExpectedR: 0.2 } });
  assert.doesNotMatch(evidence.cautions.join(' '), /Earnings are|Data quality is/);
  assert.match(evidence.cautions.join(' '), /Outcome probability is not calibrated/);
});

test('stock evidence cautions disclose unavailable and partial event coverage without inventing a probability', () => {
  const evidence = summarizeSignalEvidence({ secDataStatus: 'provider_error', corporateActionDataStatus: 'credentials_missing',
    macroDataStatus: 'partial', macroComponentsAvailable: 1, macroStress: 0,
    executionEvidence: { stressedExpectedR: 0.2 } });
  const text = evidence.cautions.join(' ');
  assert.match(text, /SEC filings context is provider error; absence of an event is not confirmed/);
  assert.match(text, /Corporate actions context is credentials missing; absence of an event is not confirmed/);
  assert.match(text, /Macro context is partial \(1 of 3 components\); its stress score is incomplete/);
  assert.doesNotMatch(text, /No additional caution rule fired/);
});

test('stock alert renders manual catalysts as unverified context and cautions to confirm them', () => {
  const row = { secDataStatus: 'available', corporateActionDataStatus: 'available', macroDataStatus: 'available', macroStress: 0,
    manualCatalysts: [{ eventType: 'earnings', direction: 'negative', expectedness: 'scheduled', impact: 'high', horizon: 'intraday', reason: 'Guidance lowered', sourceUrl: 'https://example.com' }] };
  const eventRisk = formatPointInTimeEventRisk(row);
  assert.match(eventRisk, /Operator catalyst tags \(unverified; not sentiment analysis; no score\/gate effect\): earnings \| operator-tagged direction negative \| scheduled \| impact high \| intraday: Guidance lowered/);
  assert.match(eventRisk, /https:\/\/example\.com/);
  assert.match(summarizeSignalEvidence({ ...row, executionEvidence: { stressedExpectedR: 0.2 } }).cautions.join(' '), /Operator-entered catalyst context is unverified/);
});

test('empty daily review distinguishes zero target-one hits from target-two level', async () => {
  const sent = [];
  const channel = {
    isTextBased: () => true,
    messages: { fetch: async () => sent },
    send: async (payload) => {
      const message = { id: 'review', author: { id: 'stocks-bot' }, embeds: payload.embeds.map((embed) => embed.toJSON()) };
      sent.push(message);
      return message;
    }
  };
  const client = { user: { id: 'stocks-bot' }, guilds: { fetch: async () => ({ channels: { fetch: async () => channel } }) } };
  const review = await postDailyReview(client, guildId, { dateKey: '2026-09-21', source: 'Yahoo Chart' }, []);
  assert.match(review.embeds[0].description, /No conditional paper setup was approved or posted/);
  assert.equal(review.embeds[0].fields.find((field) => field.name === 'Graded outcomes').value,
    'Target 1 hits: 0 | Target 2 hits: 0 | Shortfalls: 0 | Losses/invalidation: 0');
});
