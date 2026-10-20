import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function currentDefinitionFixture() {
  const now = Date.now();
  const expiry = new Date(now + 90 * 24 * 60 * 60_000);
  const monthCode = 'FGHJKMNQUVXZ'[expiry.getUTCMonth()];
  return { providerRawSymbol: `ES${monthCode}${expiry.getUTCFullYear() % 10}`,
    expiry: expiry.toISOString(), definitionTimestamp: new Date(now - 60 * 60_000).toISOString() };
}

test('prepare:day-session CLI prints draft JSON and leaves source inputs unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-futures-session-draft-'));
  const definitionsPath = join(directory, 'definitions.json');
  const productsPath = join(directory, 'products.json');
  const identity = currentDefinitionFixture();
  const definitions = [{ product: 'E-mini S&P 500', providerSymbol: 'ES.v.0', ...identity, providerInstrumentId: '12345',
    providerTickSize: 0.25, providerTickValue: 12.5, providerContractMultiplier: 50 }];
  const products = [{ symbol: 'E-mini S&P 500', providerSymbol: 'ES.v.0', assetClass: 'equity-index-future' }];
  try {
    await writeFile(definitionsPath, JSON.stringify(definitions));
    await writeFile(productsPath, JSON.stringify(products));
    const result = spawnSync(process.execPath, ['futures/scripts/prepareDaySessionDraft.js', definitionsPath, productsPath], {
      cwd: ROOT, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const draft = JSON.parse(result.stdout);
    assert.equal(draft.draft, true);
    assert.equal(draft.dayTrades[0].contract.providerRawSymbol, identity.providerRawSymbol);
    assert.equal(draft.dayTrades[0].contract.contractSpecVerified, false);
    assert.deepEqual(JSON.parse(await readFile(definitionsPath, 'utf8')), definitions);
    assert.deepEqual(JSON.parse(await readFile(productsPath, 'utf8')), products);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('prepare:day-session CLI preserves eligible review rows and exits nonzero when definitions are rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-futures-session-partial-'));
  const definitionsPath = join(directory, 'definitions.json');
  const productsPath = join(directory, 'products.json');
  const identity = currentDefinitionFixture();
  const definitions = [
    { product: 'E-mini S&P 500', providerSymbol: 'ES.v.0', ...identity, providerInstrumentId: '12345' },
    { product: 'Unknown product', providerRawSymbol: 'XYZ6', providerInstrumentId: '12346',
      expiry: identity.expiry, definitionTimestamp: identity.definitionTimestamp },
  ];
  const products = [{ symbol: 'E-mini S&P 500', providerSymbol: 'ES.v.0', assetClass: 'equity-index-future' }];
  try {
    await writeFile(definitionsPath, JSON.stringify(definitions));
    await writeFile(productsPath, JSON.stringify(products));
    const result = spawnSync(process.execPath, ['futures/scripts/prepareDaySessionDraft.js', definitionsPath, productsPath], {
      cwd: ROOT, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 1);
    const draft = JSON.parse(result.stdout);
    assert.equal(draft.draftedDefinitions, 1);
    assert.equal(draft.partial, true);
    assert.deepEqual(draft.rejectedDefinitions.map((row) => row.reasonCodes), [['product_not_in_reviewed_registry']]);
    assert.match(result.stderr, /rejected 1 definition/);
    assert.deepEqual(JSON.parse(await readFile(definitionsPath, 'utf8')), definitions);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
