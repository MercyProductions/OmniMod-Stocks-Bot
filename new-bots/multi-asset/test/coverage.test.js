import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readJson = (path) => readFile(new URL(path, import.meta.url), 'utf8').then(JSON.parse);

test('default market preset covers requested funds and macro asset groups', async () => {
  const markets = await readJson('../examples/wrappers-and-macro-markets.json');
  const symbols = markets.map((row) => row.providerSymbol);
  const classes = new Set(markets.map((row) => row.assetClass));

  assert.equal(markets.length, 30);
  assert.equal(new Set(symbols).size, symbols.length);
  for (const type of [
    'leveraged-equity-index-etf', 'inverse-leveraged-equity-index-etf',
    'gold-etf', 'oil-etf', 'long-duration-treasury-etf',
    'investment-grade-corporate-bond-etf', 'volatility-etn',
  ]) assert.ok(classes.has(type), `missing ${type}`);
  assert.ok(markets.filter((row) => row.leverageReset === 'daily').length >= 8);
});

test('options sample spans index, commodity, bond, leveraged and inverse underlyings within provider cap', async () => {
  const options = await readJson('../examples/options-universe.json');
  const symbols = options.map((row) => row.symbol);

  assert.equal(options.length, 12);
  assert.equal(new Set(symbols).size, symbols.length);
  for (const symbol of ['SPY', 'GLD', 'USO', 'TLT', 'HYG', 'UPRO', 'SQQQ', 'TQQQ', 'VXX']) {
    assert.ok(symbols.includes(symbol), `missing ${symbol}`);
  }
  assert.ok(options.every((row) => row.expiry === 'auto'));
});
