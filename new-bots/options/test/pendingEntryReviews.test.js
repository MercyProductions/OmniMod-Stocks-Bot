import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { loadPendingOptionReviews } from '../src/pendingEntryReviews.js';
import { fixture, NOW, iso } from './helpers/optionFillFixture.js';

const order = (source = 'manual') => ({ orderId: source, status: 'reserved', owner: 'options', assetClass: 'option',
  option: { underlyingSymbol: 'SPY', entryValidation: { catalystSource: source } } });
const review = () => ({ ...fixture().signal.catalystReview, symbol: 'SPY' });

test('current manual file revocation and duplicate reviews are read independently of the shortlist', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-entry-review-'));
  t.after(async () => { const rel = relative(tmpdir(), dir); assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..')); await rm(dir, { recursive: true, force: true }); });
  const path = join(dir, 'reviews.json');
  const settings = { env: { OPTIONS_CATALYST_REVIEW_FILE: path }, now: NOW, clockNow: () => NOW,
    fetchImpl: async () => { throw new Error('Manual review must not make provider requests.'); } };
  const read = () => loadPendingOptionReviews([order()], settings);
  await writeFile(path, JSON.stringify({ reviews: [review()] }));
  assert.equal((await read()).get('manual').review.status, 'clear');
  await writeFile(path, JSON.stringify({ reviews: [{ ...review(), status: 'blocked' }] }));
  assert.equal((await read()).get('manual').review.status, 'blocked');
  await writeFile(path, JSON.stringify({ reviews: [review(), review()] }));
  assert.equal((await read()).get('manual').review.status, 'blocked');
  await writeFile(path, '{invalid');
  assert.equal((await read()).get('manual').review.status, 'blocked');
  const session = join(dir, 'session.json');
  const readSession = () => loadPendingOptionReviews([order()], { ...settings, manualSessionFile: session });
  await writeFile(session, JSON.stringify({ signals: [{ signal: { underlyingSymbol: 'SPY', catalystReview: review() } }] }));
  assert.equal((await readSession()).get('manual').review.status, 'clear');
  await writeFile(session, JSON.stringify({ signals: [{ signal: { underlyingSymbol: 'SPY', catalystReview: { ...review(), status: 'blocked' } } }] }));
  assert.equal((await readSession()).get('manual').review.status, 'blocked');
});

test('new company news invalidates manual clearance while failed coverage never becomes clear', async () => {
  let fail = false;
  const fetchImpl = async url => {
    assert.equal(new URL(url).hostname, 'data.alpaca.markets');
    return { ok: !fail, status: fail ? 503 : 200, headers: new Headers(), json: async () => ({ news: [{ id: 12,
      symbols: ['SPY'], source: 'Synthetic wire', headline: 'Synthetic newer announcement', created_at: iso(NOW + 500), updated_at: iso(NOW + 500) }], next_page_token: null }) };
  };
  const settings = { env: { ALPACA_API_KEY_ID: 'fixture', ALPACA_API_SECRET_KEY: 'fixture' }, manualReviews: [review()],
    now: NOW + 1000, clockNow: () => NOW + 1000, requestGate: async () => ({}), fetchImpl };
  const loaded = await loadPendingOptionReviews([order('alpaca')], settings);
  assert.equal(loaded.get('alpaca').review.status, 'blocked');
  assert.match(loaded.get('alpaca').review.summary, /newer/);
  fail = true;
  assert.equal((await loadPendingOptionReviews([order('alpaca')], settings)).get('alpaca').review.status, 'blocked');
});

test('combined calendar/news modes use both configured sources and preserve the oldest check time', async () => {
  let time = NOW; const calls = [];
  const rows = await loadPendingOptionReviews([order('finnhub+alpaca')], { now: NOW, clockNow: () => time,
    env: { FINNHUB_API_KEY: 'fixture', ALPACA_API_KEY_ID: 'fixture', ALPACA_API_SECRET_KEY: 'fixture' },
    requestGate: async () => ({}), fetchImpl: async url => {
      const host = new URL(url).hostname; calls.push(host); time += 1000;
      return { ok: true, status: 200, headers: new Headers(), json: async () => host === 'finnhub.io'
        ? { economicCalendar: [] } : { news: [], next_page_token: null } };
    } });
  assert.deepEqual(calls, ['finnhub.io', 'data.alpaca.markets']);
  assert.equal(rows.get('finnhub+alpaca').review.status, 'clear');
  assert.equal(rows.get('finnhub+alpaca').checkedAt, iso(NOW + 1000));
});

test('expired review budget and missing credentials fail closed while filled positions request no entry review', async () => {
  let time = NOW;
  const settings = { env: { FINNHUB_API_KEY: 'fixture' }, now: NOW, clockNow: () => time,
    fetchImpl: async () => { time += 8001; return { ok: true, status: 200, headers: new Headers(), json: async () => ({ economicCalendar: [] }) }; } };
  assert.equal((await loadPendingOptionReviews([order('finnhub')], settings)).get('finnhub').review.status, 'blocked');
  assert.equal((await loadPendingOptionReviews([order('finnhub')], { ...settings, env: {} })).get('finnhub').review.status, 'blocked');
  let called = false;
  assert.equal((await loadPendingOptionReviews([{ ...order(), status: 'filled' }], { fetchImpl: async () => { called = true; } })).size, 0);
  assert.equal(called, false);
});
