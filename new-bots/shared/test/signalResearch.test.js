import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIntradayPrimaryResearch, publishPrimaryResearchSignals, readPrimaryResearchSignals, readPrimaryResearchSignalsWithDiagnostics } from '../signalResearch.js';

test('shared research reader reports stale, malformed, untrusted, and duplicate source rows without exposing unrelated owners', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-signals-diagnostics-'));
  const file = join(dir, 'signals.jsonl');
  const now = Date.parse('2026-09-30T15:00:00Z');
  const row = (id, owner = 'stocks', observedAt = new Date(now).toISOString(), extra = {}) => ({ id, owner,
    observedAt, executable: false, paperOnly: true, symbol: 'ABC', ...extra });
  try {
    await writeFile(file, [
      JSON.stringify(row('good')),
      JSON.stringify(row('stale', 'etfs-etps', new Date(now - 600_000).toISOString())),
      JSON.stringify(row('future', 'stocks', new Date(now + 60_000).toISOString())),
      JSON.stringify(row('untrusted', 'stocks', new Date(now).toISOString(), { executable: true })),
      JSON.stringify(row('duplicate')),
      JSON.stringify(row('duplicate')),
      JSON.stringify(row('other-owner', 'crypto')),
      '{bad json',
    ].join('\n'), 'utf8');
    const { records, diagnostics } = await readPrimaryResearchSignalsWithDiagnostics({ file, now, maxAgeMs: 120_000, owners: ['stocks', 'etfs-etps'] });
    assert.deepEqual(records.map(({ id }) => id), ['good', 'duplicate']);
    assert.equal(diagnostics.linesRead, 8);
    assert.equal(diagnostics.acceptedRecords, 2);
    assert.equal(diagnostics.expiredRecords, 1);
    assert.deepEqual(diagnostics.expiredByOwner, { 'etfs-etps': 1 });
    assert.equal(diagnostics.duplicateRecords, 1);
    assert.equal(diagnostics.malformedJsonRows, 1);
    assert.equal(diagnostics.rejectionCounts.observation_from_future, 1);
    assert.equal(diagnostics.rejectionCounts.signal_not_explicitly_non_executable, 1);
    assert.equal(diagnostics.rejectionCounts.duplicate_signal_id, 1);
    assert.equal(diagnostics.rejectionCounts.malformed_json, 1);
    assert.equal(diagnostics.rejectedRecordCount, 4);
    assert.ok(!diagnostics.rejectionCounts.source_owner_invalid);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cross-bot day-trading context accepts only recognized short-horizon strategy labels', () => {
  for (const strategyId of ['intraday', 'daytrade', 'scalp', 'momentum', 'rapid', 'session', 'stocks:scalp', 'crypto:rapid']) {
    assert.equal(isIntradayPrimaryResearch({ strategyId }), true, strategyId);
  }
  for (const strategyId of ['swing', 'long-hold', 'investment', 'unknown', '']) {
    assert.equal(isIntradayPrimaryResearch({ strategyId }), false, strategyId);
  }
  assert.equal(isIntradayPrimaryResearch({ owner: 'futures', strategyFamily: 'intraday_day_trade', strategyId: 'futures-opening-range-v1' }), true);
  assert.equal(isIntradayPrimaryResearch({ owner: 'multi-asset', strategyFamily: 'intraday_day_trade' }), false);
});

test('cross-market records preserve the native instrument and shared exposure identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-signals-exposure-'));
  const file = join(dir, 'signals.jsonl');
  const now = Date.parse('2026-09-29T15:00:00Z');
  try {
    await publishPrimaryResearchSignals('futures', [{ id: 'es-paper', symbol: 'SPY', instrumentKey: 'ESZ6', exposureKey: 'SPY',
      direction: 'long', strategyFamily: 'intraday_day_trade', strategyId: 'futures-opening-range-v1', status: 'active',
      createdAt: new Date(now).toISOString(), entryPrice: 5700, stopPrice: 5690, targetPrice: 5720 }], { file, now });
    const rows = await readPrimaryResearchSignals({ file, now, owners: ['futures'] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].instrumentKey, 'ESZ6');
    assert.equal(rows[0].exposureKey, 'SPY');
    assert.equal(isIntradayPrimaryResearch(rows[0]), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('primary signal journal shares delivered paper research but never marks it executable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-signals-'));
  const file = join(dir, 'signals.jsonl');
  const now = Date.parse('2026-09-29T15:00:00Z');
  try {
    const result = await publishPrimaryResearchSignals('stocks', [{ id: 's1', symbol: 'spy', action: 'PAPER LONG', status: 'tracking', createdAt: new Date(now).toISOString(), entryLow: 99, entryHigh: 100, targetPrice: 105 }], { file, now });
    assert.equal(result.rowsWritten, 1);
    const rows = await readPrimaryResearchSignals({ file, now: now + 5_000 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].symbol, 'SPY');
    assert.equal(rows[0].direction, 'long');
    assert.equal(rows[0].executable, false);
    assert.equal(rows[0].paperOnly, true);
    assert.equal(rows[0].strategyId, 'unknown');
    assert.equal(isIntradayPrimaryResearch(rows[0]), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('primary signal journal never invents a long direction from missing or flat evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-signals-direction-'));
  const file = join(dir, 'signals.jsonl');
  const now = Date.parse('2026-09-29T15:00:00Z');
  try {
    const result = await publishPrimaryResearchSignals('stocks', [
      { id: 'missing', symbol: 'AAA', status: 'tracking', createdAt: new Date(now).toISOString() },
      { id: 'flat', symbol: 'BBB', status: 'tracking', entryPrice: 10, targetPrice: 10, createdAt: new Date(now).toISOString() },
      { id: 'lower-target', symbol: 'CCC', status: 'tracking', entryPrice: 10, targetPrice: 9, createdAt: new Date(now).toISOString() },
      { id: 'buy-action', symbol: 'DDD', action: 'CONDITIONAL BUY', status: 'tracking', createdAt: new Date(now).toISOString() },
      { id: 'abstained-buy', symbol: 'EEE', action: 'BUY / DO NOT OPEN A PAPER TRADE', status: 'tracking', entryPrice: 10, targetPrice: 12, createdAt: new Date(now).toISOString() },
      { id: 'conflicting', symbol: 'FFF', action: 'BUY', direction: 'short', status: 'tracking', createdAt: new Date(now).toISOString() },
    ], { file, now });
    assert.equal(result.rowsWritten, 2);
    assert.equal(result.rowsRejected, 4);
    assert.deepEqual(result.rejectionCounts, { explicit_no_action: 1, ambiguous_direction: 3, other_invalid_record: 0 });
    const rows = await readPrimaryResearchSignals({ file, now });
    assert.deepEqual(rows.map((row) => [row.signalId, row.direction]), [['lower-target', 'short'], ['buy-action', 'long']]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('primary signal journal excludes stale and malformed rows and deduplicates repeated publication', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-signals-'));
  const file = join(dir, 'signals.jsonl');
  const now = Date.parse('2026-09-29T15:00:00Z');
  const signal = { id: 's1', symbol: 'BTC', direction: 'short', status: 'tracking', createdAt: new Date(now - 60_000).toISOString(), targetPrice: 90 };
  try {
    await publishPrimaryResearchSignals('crypto', [signal, signal], { file, now });
    const fresh = await readPrimaryResearchSignals({ file, now: now + 60_000, maxAgeMs: 120_000 });
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].direction, 'short');
    const expired = await readPrimaryResearchSignals({ file, now: now + 60_000, maxAgeMs: 30_000 });
    assert.equal(expired.length, 0);
    await assert.rejects(() => publishPrimaryResearchSignals('stocks', null, { file, now }), /array/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('journal options are validated even when a scan has no publishable signals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-signals-options-'));
  const file = join(dir, 'signals.jsonl');
  try {
    for (const options of [
      { retentionMs: 0 }, { maxRecords: 0 }, { lockTimeoutMs: Number.NaN }, { now: Number.NaN },
    ]) {
      await assert.rejects(() => publishPrimaryResearchSignals('stocks', [], { file, ...options }));
    }
    await assert.rejects(() => readPrimaryResearchSignals({ file, now: Number.NaN }), /finite timestamp/);
    await assert.rejects(() => readPrimaryResearchSignals({ file, owners: ['other'] }), /known signal owners/);
    await assert.rejects(() => readPrimaryResearchSignals({ file, owners: 'stocks' }), /known signal owners/);
    await assert.rejects(() => readFile(file, 'utf8'), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('primary signal journal compacts expired history and enforces a record cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-signals-retention-'));
  const file = join(dir, 'signals.jsonl');
  const firstAt = Date.parse('2026-09-01T15:00:00Z');
  const laterAt = Date.parse('2026-09-03T15:00:00Z');
  try {
    await publishPrimaryResearchSignals('stocks', [
      { id: 'expired', symbol: 'AAA', direction: 'long', status: 'tracking', createdAt: new Date(firstAt).toISOString() },
    ], { file, now: firstAt });
    await publishPrimaryResearchSignals('crypto', [
      { id: 'kept-1', symbol: 'BTC', direction: 'long', status: 'tracking', createdAt: new Date(laterAt - 1_000).toISOString() },
      { id: 'kept-2', symbol: 'ETH', direction: 'short', status: 'tracking', createdAt: new Date(laterAt).toISOString() },
    ], { file, now: laterAt, retentionMs: 24 * 60 * 60_000, maxRecords: 1 });
    const rows = await readPrimaryResearchSignals({ file, now: laterAt, maxAgeMs: 5 * 60_000 });
    assert.deepEqual(rows.map((row) => row.signalId), ['kept-2']);
    const lines = (await readFile(file, 'utf8')).trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).signalId, 'kept-2');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('concurrent primary-signal publishers serialize compaction without losing either owner row', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-signals-concurrent-'));
  const file = join(dir, 'signals.jsonl');
  const now = Date.parse('2026-09-29T15:00:00Z');
  try {
    await Promise.all([
      publishPrimaryResearchSignals('stocks', [{ id: 's-concurrent', symbol: 'SPY', direction: 'long', status: 'tracking', createdAt: new Date(now).toISOString() }], { file, now }),
      publishPrimaryResearchSignals('crypto', [{ id: 'c-concurrent', symbol: 'BTC', direction: 'short', status: 'tracking', createdAt: new Date(now).toISOString() }], { file, now }),
    ]);
    const rows = await readPrimaryResearchSignals({ file, now });
    assert.deepEqual(rows.map((row) => row.owner).sort(), ['crypto', 'stocks']);
    assert.equal((await readFile(file, 'utf8')).trim().split(/\r?\n/).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('signal publisher reclaims a confirmed dead local lock but preserves an active lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-signals-lock-'));
  const file = join(dir, 'signals.jsonl');
  const lockPath = `${file}.lock`;
  const now = Date.parse('2026-09-29T15:00:00Z');
  const rows = [{ id: 'lock-check', symbol: 'SPY', direction: 'long', status: 'tracking', createdAt: new Date(now).toISOString() }];
  try {
    await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, hostname: hostname(), startedAt: new Date(now - 60_000).toISOString() }));
    const recovered = await publishPrimaryResearchSignals('stocks', rows, { file, now });
    assert.equal(recovered.rowsWritten, 1);

    await writeFile(lockPath, JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() }));
    await assert.rejects(() => publishPrimaryResearchSignals('crypto', rows, { file, now, lockTimeoutMs: 1 }), /journal is locked/);
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid, 'active lock owner must not be modified');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing or unrecognized publisher status is unknown rather than active', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-signals-'));
  const file = join(dir, 'signals.jsonl');
  const now = Date.parse('2026-09-29T15:00:00Z');
  try {
    await publishPrimaryResearchSignals('stocks', [
      { id: 'missing-status', symbol: 'SPY', direction: 'long', createdAt: new Date(now).toISOString() },
      { id: 'bad-status', symbol: 'QQQ', direction: 'long', status: 'maybe', createdAt: new Date(now).toISOString() },
    ], { file, now });
    const rows = await readPrimaryResearchSignals({ file, now });
    assert.deepEqual(rows.map((row) => row.status), ['unknown', 'unknown']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('shared signal research carries only bounded, point-in-time, sanitized unscored headlines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-signals-news-'));
  const file = join(dir, 'signals.jsonl');
  const now = Date.parse('2026-09-29T15:00:00Z');
  try {
    await publishPrimaryResearchSignals('stocks', [{ id: 's-news', symbol: 'NVDA', direction: 'long', status: 'tracking',
      createdAt: new Date(now).toISOString(), recentNewsStatus: 'available', recentNews: [
        { publisher: 'Wire', headline: '  New\nproduct announced ', activityAt: new Date(now - 60_000).toISOString(), sourceUrl: 'https://news.example/a' },
        { publisher: 'Wire', headline: 'Future item', activityAt: new Date(now + 60_001).toISOString(), sourceUrl: 'https://news.example/b' },
        { publisher: 'Wire', headline: 'Old item', activityAt: new Date(now - 25 * 60 * 60_000).toISOString(), sourceUrl: 'https://news.example/c' },
        { publisher: 'Wire', headline: 'Unsafe link', activityAt: new Date(now - 30_000).toISOString(), sourceUrl: 'http://news.example/d' },
        { publisher: 'Wire', headline: 'Third item', activityAt: new Date(now - 30_000).toISOString(), sourceUrl: 'https://news.example/e' },
      ] }], { file, now });
    await publishPrimaryResearchSignals('crypto', [{ id: 'c-news', symbol: 'BTC', direction: 'short', status: 'tracking',
      createdAt: new Date(now).toISOString(), recentMarketNews: [{ source: 'Finnhub Wire', headline: 'Exchange outage reported',
        publishedAt: new Date(now - 5_000).toISOString(), url: 'https://news.example/crypto' }] }], { file, now });
    const rows = await readPrimaryResearchSignals({ file, now });
    const row = rows.find((item) => item.owner === 'stocks');
    assert.equal(row.catalystContextStatus, 'available');
    assert.equal(row.executable, false);
    assert.equal(row.catalystContext.length, 2);
    assert.equal(row.catalystContext[0].headline, 'New product announced');
    assert.equal(row.catalystContext[0].sourceUrl, 'https://news.example/a');
    assert.deepEqual(Object.keys(row.catalystContext[0]).sort(), ['activityAt', 'headline', 'publisher', 'sourceUrl']);
    const crypto = rows.find((item) => item.owner === 'crypto');
    assert.equal(crypto.catalystContextStatus, 'available');
    assert.equal(crypto.catalystContext[0].headline, 'Exchange outage reported');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
