import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-storage-'));
process.env.OMNIMOD_STOCKS_DATA_DIR = directory;
const storage = await import('../src/storage.js');

test('storage preserves ledgers and never treats corruption as no prior trades', async (t) => {
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const fallback = { missing: true };
  assert.deepEqual(await storage.readJson(path.join(directory, 'missing.json'), fallback), fallback);
  const corrupt = path.join(directory, 'corrupt.json');
  await fs.writeFile(corrupt, '{"private":"must-not-leak",');
  await assert.rejects(storage.readJson(corrupt, fallback), (error) => {
    assert.equal(error.message, 'Unable to read stored JSON: corrupt.json');
    assert.ok(!error.message.includes('must-not-leak'));
    return true;
  });
  await fs.mkdir(path.join(directory, 'not-a-file.json'));
  await assert.rejects(storage.readJson(path.join(directory, 'not-a-file.json'), fallback));
  assert.deepEqual((await storage.readTracker('new')).predictions, []);
  await fs.writeFile(storage.paths.tracker('broken'), '{}');
  await assert.rejects(storage.readTracker('broken'), /Invalid tracker ledger/);
  const ledger = { version: 1, guildId: 'valid', predictions: [{ id: 'loss', status: 'loss' }] };
  await storage.writeTracker('valid', ledger);
  assert.deepEqual(await storage.readTracker('valid'), ledger);
  const writes = Array.from({ length: 24 }, (_, id) => storage.writeJson(path.join(directory, 'parallel.json'), { id, payload: 'x'.repeat(1000) }));
  await Promise.all(writes);
  const saved = await storage.readJson(path.join(directory, 'parallel.json'));
  assert.ok(Number.isInteger(saved.id));
  assert.equal(saved.payload.length, 1000);
  const blocked = path.join(directory, 'blocked.json');
  await fs.mkdir(blocked);
  await assert.rejects(storage.writeJson(blocked, { value: 1 }));
  assert.equal((await fs.readdir(directory)).filter((name) => name.endsWith('.tmp')).length, 0);
});
