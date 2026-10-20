import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('combined discovery CLI fails closed on missing Databento credentials before requesting data', () => {
  const result = spawnSync(process.execPath, ['scripts/discoverDaySessionDraft.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 5_000,
    env: { ...process.env, DATABENTO_API_KEY: '', FUTURES_MAX_SCAN_COST_USD: '0' },
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABENTO_API_KEY is required/);
  assert.equal(result.stdout, '');
});

test('combined discovery CLI resolves volume-ranked roots and emits an unchanged review-only session draft', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-futures-active-discovery-'));
  const productsPath = join(directory, 'products.json');
  const sessionPath = join(directory, 'day-session.json');
  const products = [
    { symbol: 'E-mini S&P 500', providerSymbol: 'ES.v.0', assetClass: 'equity-index-future', underlying: 'S&P 500' },
    { symbol: 'Gold', providerSymbol: 'GC.v.0', assetClass: 'metal-future', underlying: 'Gold' },
  ];
  const session = { sessionDate: null, dayTrades: [], marks: [] };
  const definitions = [{ publisher_id: 1, instrument_id: 101, asset: 'ES', raw_symbol: 'ESZ9', instrument_class: 'F',
    expiration: '2099-12-18T14:30:00.000Z', ts_recv: new Date().toISOString(), exchange: 'XCME',
    min_price_increment: 250000000, display_factor: 1000000000, min_price_increment_amount: 12500000000, contract_multiplier: 50 }];
  const preload = fileURLToPath(new URL('./fixtures/mockActiveContractDiscovery.mjs', import.meta.url));
  try {
    await writeFile(productsPath, JSON.stringify(products));
    await writeFile(sessionPath, JSON.stringify(session));
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, 'scripts/discoverDaySessionDraft.js'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, DATABENTO_API_KEY: 'test-only-key', DATABENTO_DATASET: 'GLBX.MDP3', FUTURES_MAX_SCAN_COST_USD: '0.05',
        FUTURES_FILE: productsPath, FUTURES_DAY_SESSION_FILE: sessionPath, OMNIMOD_TEST_DATABENTO_DEFINITIONS: JSON.stringify(definitions) },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'review_required');
    assert.equal(report.providerEstimatedCostUsd, 0.01);
    assert.equal(report.tradeEligibleContracts, 0);
    assert.deepEqual(report.volumeRankMappings.map(({ status }) => status), ['resolved', 'no_current_mapping']);
    assert.equal(report.reviewDraft.dayTrades.length, 1);
    assert.equal(report.reviewDraft.dayTrades[0].contract.providerRawSymbol, 'ESZ9');
    assert.equal(report.reviewDraft.dayTrades[0].preparationStatus, 'draft_requires_manual_review');
    assert.match(report.note, /not proof of current-session liquidity/);
    assert.deepEqual(JSON.parse(await readFile(productsPath, 'utf8')), products);
    assert.deepEqual(JSON.parse(await readFile(sessionPath, 'utf8')), session);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
