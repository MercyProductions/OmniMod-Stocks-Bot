import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAlpacaEtfSession } from '../src/alpacaMarketData.js';
import { evaluateOpeningRangeBreakout } from '../src/strategies.js';
import { evaluatePaperCandidate, reservePaperCandidate, readPaperRiskLedger } from '../../shared/paperRisk.js';
import { etfInput, rawQuote, NOW, portfolio, policy } from './quoteRefreshFixtures.js';

test('fresh-at-receipt ETF quote remains a dated research input when bars finish twenty seconds later', async () => {
  const original = Date.now, realStart = original(); let extra = 0;
  Date.now = () => NOW + extra + original() - realStart;
  try {
    const input = etfInput(), payload = value => ({ ok: true, status: 200, headers: new Headers(), json: async () => value });
    let snapshotParsed;
    const snapshotReady = new Promise(done => { snapshotParsed = done; });
    const result = await fetchAlpacaEtfSession({ now: new Date(NOW), observationClock: Date.now,
      env: { ETF_DISCOVERY_MODE: 'baseline', ETF_SYMBOLS: 'SPY', ETF_ALPACA_FEED: 'sip', ALPACA_API_KEY_ID: 'baseline-fixture', ALPACA_API_SECRET_KEY: 'fixture',
        ETF_UNIVERSE_CACHE_PATH: fileURLToPath(new URL('./fixtures/etf-universe-cache.json', import.meta.url)) },
      catalystReviews: { SPY: input.session.catalystReview }, fetcher: async url => {
        if (url.includes('/clock')) return payload({ timestamp: new Date(Date.now()).toISOString(), is_open: true });
        if (url.includes('/calendar')) return payload([{ date: '2026-09-29', open: '09:30', close: '16:00' }]);
        if (url.includes('/assets')) return payload([{ symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', exchange: 'ARCA', status: 'active', tradable: true }]);
        if (url.includes('/news')) return payload({ news: [] });
        if (url.includes('/snapshots')) {
          const value = { SPY: { latestQuote: rawQuote(Date.now()) } };
          return { ok: true, status: 200, headers: new Headers(), json: async () => { snapshotParsed(); return value; } };
        }
        if (url.includes('/bars')) {
          await snapshotReady;
          await new Promise(done => setImmediate(done)); extra += 20000;
          return payload({ bars: { SPY: input.bars.map(b => ({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume })) } });
        }
        throw new Error('Unexpected synthetic endpoint');
      } });
    assert.equal(result.trades.length, 1);
    assert.ok(Date.now() - Date.parse(result.trades[0].quote.time) > 15000);
    assert.equal(evaluateOpeningRangeBreakout({ ...result.trades[0], now: Date.now(), config: input.config }).reasons.includes('stale_or_future_quote'), true);
  } finally { Date.now = original; }
});

test('ETF candidate expiry preserves the strategy entry-window cutoff', () => {
  const input = etfInput(), candidate = evaluateOpeningRangeBreakout({ ...input, now: NOW }).candidate;
  assert.equal(candidate.entryExpiresAt, new Date(input.session.closeTime - 30 * 60000).toISOString());
});

test('reservation rechecks quote age at the locked observation time', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'etf-expired-reservation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const candidate = evaluateOpeningRangeBreakout({ ...etfInput(), now: NOW }).candidate;
  const decision = evaluatePaperCandidate(candidate, portfolio(), policy());
  assert.equal(decision.status, 'paper-approved');
  const statePath = join(directory, 'ledger.json');
  const result = await reservePaperCandidate(candidate, decision, { statePath, now: NOW, emergencyStop: false, observationClock: () => NOW + 15001 });
  assert.equal(result.reason, 'quote_expired_before_reservation');
  assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 0);
});

test('reviewed ETP source and review time survive acquisition into strategy evaluation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'etf-review-propagation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const classificationPath = join(directory, 'classification.json'), input = etfInput('NVD');
  const review = { symbol: 'NVD', productType: 'inverse_etf', exposureKey: 'NVDA', leverage: -2, inverse: true,
    sourceUrl: 'https://graniteshares.com/etfs/nvd/', reviewedAt: new Date(NOW).toISOString() };
  await writeFile(classificationPath, JSON.stringify([review]));
  const payload = value => ({ ok: true, status: 200, headers: new Headers(), json: async () => value });
  const session = await fetchAlpacaEtfSession({ now: new Date(NOW), observationClock: () => NOW,
    env: { ETF_DISCOVERY_MODE: 'baseline', ETF_SYMBOLS: 'NVD', ETF_ALPACA_FEED: 'sip', ALPACA_API_KEY_ID: 'synthetic', ALPACA_API_SECRET_KEY: 'synthetic',
      ETF_ETP_CLASSIFICATION_PATH: classificationPath }, catalystReviews: { NVD: input.session.catalystReview }, fetcher: async url => {
      if (url.includes('/clock')) return payload({ timestamp: new Date(NOW).toISOString(), is_open: true });
      if (url.includes('/calendar')) return payload([{ date: '2026-09-29', open: '09:30', close: '16:00' }]);
      if (url.includes('/assets')) return payload([{ symbol: 'NVD', status: 'active', tradable: true, exchange: 'NASDAQ', name: 'NVD' }]);
      if (url.includes('/news')) return payload({ news: [] });
      if (url.includes('/snapshots')) return payload({ NVD: { latestQuote: rawQuote(NOW) } });
      if (url.includes('/bars')) return payload({ bars: { NVD: input.bars.map(b => ({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume })) } });
      throw new Error('Unexpected synthetic endpoint');
    } });
  assert.equal(session.trades[0].classificationSourceUrl, review.sourceUrl);
  assert.equal(session.trades[0].classificationReviewedAt, review.reviewedAt);
  assert.equal(evaluateOpeningRangeBreakout({ ...session.trades[0], now: NOW, config: input.config }).status, 'candidate');
});
