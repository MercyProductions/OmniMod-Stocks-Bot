import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('manual stock catalysts validate HTTPS sources, persist tags and distinguish active/upcoming context', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-stock-catalysts-'));
  process.env.OMNIMOD_STOCKS_DATA_DIR = directory;
  try {
    const { addManualCatalyst, listManualCatalysts, catalystsForSymbol, clearManualCatalyst } = await import('../src/manualCatalysts.js');
    const now = new Date('2026-09-27T15:00:00.000Z');
    const active = await addManualCatalyst('12345', { symbol: 'NVDA', reason: 'Quarterly earnings call', eventType: 'earnings',
      direction: 'unknown', expectedness: 'scheduled', horizon: 'intraday', impact: 'high',
      sourceUrl: 'https://investor.example.com/events', startsAt: new Date(now.getTime() - 30 * 60_000), endsAt: new Date(now.getTime() + 2 * 60 * 60_000) });
    const upcoming = await addManualCatalyst('12345', { symbol: '*', reason: 'Economic release', eventType: 'macro', direction: 'neutral',
      expectedness: 'scheduled', horizon: 'swing', impact: 'medium', startsAt: new Date(now.getTime() + 24 * 60 * 60_000),
      endsAt: new Date(now.getTime() + 25 * 60 * 60_000) });
    assert.equal((await listManualCatalysts('12345', now)).length, 1);
    assert.deepEqual(catalystsForSymbol(await listManualCatalysts('12345', now, { activeOnly: false }), 'NVDA', now).map((row) => row.id), [active.id, upcoming.id]);
    await assert.rejects(addManualCatalyst('12345', { symbol: 'NVDA', reason: 'bad source', sourceUrl: 'https://user:pass@example.com' }), /HTTPS URL up to 500 characters/);
    assert.equal(await clearManualCatalyst('12345', 'NVDA'), 1);
    assert.equal((await listManualCatalysts('12345', now)).length, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
