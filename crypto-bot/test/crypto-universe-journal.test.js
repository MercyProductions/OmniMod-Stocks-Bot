import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crypto-universe-history-'));
process.env.OMNIMOD_CRYPTO_DATA_DIR = directory;
const { appendCryptoUniverseSnapshot, readCryptoUniverseSnapshot, cryptoUniverseJournalRetentionDays } = await import('../src/cryptoUniverseJournal.js');
after(async () => {
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});

function snapshot({ source = 'CoinGecko public', fetchedAt, assets }) {
  return { source, fetchedAt, providerReportedTotal: 100, providerRowsReturned: assets.length, queryOrder: 'volume_desc + market_cap_desc',
    marketCapRankCapRequested: 250, discoveryPages: 2, marketCapPagesFetched: 1, marketCapPagesRequested: 1, assets };
}

test('daily Crypto universe archive stores immutable dated membership by provider and keeps the latest daily observation', async () => {
  const expired = path.join(directory, 'crypto-universe-coinpaprika-2020-01-01.json.gz');
  await fs.writeFile(expired, 'expired fixture');
  const first = snapshot({ fetchedAt: '2026-09-24T10:00:00.000Z', assets: [
    { id: 'bitcoin', symbol: 'btc', rank: 1 }, { id: 'ethereum', symbol: 'eth', rank: 2 }
  ] });
  const recorded = await appendCryptoUniverseSnapshot(first);
  assert.equal(recorded.status, 'recorded');
  assert.equal(recorded.assetCount, 2);
  assert.equal(recorded.retentionDays, cryptoUniverseJournalRetentionDays);
  await assert.rejects(fs.stat(expired), { code: 'ENOENT' });
  const sameDay = await readCryptoUniverseSnapshot('2026-09-24', 'coingecko');
  assert.deepEqual(sameDay.assets.map((row) => row.id), ['bitcoin', 'ethereum']);
  assert.equal(sameDay.providerReportedTotal, 100);

  const older = snapshot({ fetchedAt: '2026-09-24T09:00:00.000Z', assets: [{ id: 'stale', symbol: 'stl', rank: 99 }] });
  assert.equal((await appendCryptoUniverseSnapshot(older)).status, 'unchanged');
  assert.deepEqual((await readCryptoUniverseSnapshot('2026-09-24', 'coingecko')).assets.map((row) => row.id), ['bitcoin', 'ethereum']);

  const later = snapshot({ fetchedAt: '2026-09-24T16:00:00.000Z', assets: [
    { id: 'bitcoin', symbol: 'btc', rank: 1 }, { id: 'solana', symbol: 'sol', rank: 6 }, { id: 'bitcoin', symbol: 'btc', rank: 1 }
  ] });
  assert.equal((await appendCryptoUniverseSnapshot(later)).assetCount, 2);
  assert.deepEqual((await readCryptoUniverseSnapshot('2026-09-24', 'coingecko')).assets.map((row) => row.id), ['bitcoin', 'solana']);

  const paprika = snapshot({ source: 'CoinPaprika public fallback', fetchedAt: '2026-09-24T16:30:00.000Z', assets: [{ id: 'btc-bitcoin', symbol: 'BTC', rank: 1 }] });
  assert.equal((await appendCryptoUniverseSnapshot(paprika)).provider, 'coinpaprika');
  assert.equal((await readCryptoUniverseSnapshot('2026-09-24', 'coinpaprika')).assetCount, 1);
  assert.equal((await readCryptoUniverseSnapshot('2026-09-23', 'coingecko')), null);
});

test('unrecognized providers, bad timestamps and corrupt dated archives never create or replace membership history', async () => {
  assert.equal((await appendCryptoUniverseSnapshot({ source: 'unknown', fetchedAt: '2026-09-24T12:00:00Z', assets: [{ id: 'x' }] })).status, 'skipped');
  assert.equal((await appendCryptoUniverseSnapshot({ source: 'CoinGecko', fetchedAt: 'bad', assets: [{ id: 'x' }] })).status, 'skipped');
  const file = path.join(directory, 'crypto-universe-coingecko-2026-09-24.json.gz');
  const damaged = Buffer.from('do not replace a damaged historical record');
  await fs.writeFile(file, damaged);
  await assert.rejects(appendCryptoUniverseSnapshot(snapshot({ fetchedAt: '2026-09-24T13:00:00.000Z', assets: [{ id: 'bitcoin', rank: 1 }] })), /Unable to read Crypto universe journal/);
  assert.deepEqual(await fs.readFile(file), damaged);
});
