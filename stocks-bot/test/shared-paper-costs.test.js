import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configUrl = pathToFileURL(`${projectRoot}/src/config.js`).href;

function readStockPaperFee(envValue) {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { config } from ${JSON.stringify(configUrl)}; process.stdout.write(JSON.stringify({ fee: Number.isFinite(config.sharedPaperRoundTripFeesPerShare) ? config.sharedPaperRoundTripFeesPerShare : null, configured: config.sharedPaperCostAssumptionsConfigured }));`],
  { cwd: projectRoot, env: { ...process.env, STOCKS_STOCKS_ROUND_TRIP_FEES_PER_SHARE: envValue }, encoding: 'utf8' });
  return JSON.parse(output);
}

test('stock shared paper fee reserve requires an explicit valid per-share round-trip input', () => {
  assert.deepEqual(readStockPaperFee(''), { fee: null, configured: false });
  assert.deepEqual(readStockPaperFee('0'), { fee: 0, configured: true });
  assert.deepEqual(readStockPaperFee('0.025'), { fee: 0.025, configured: true });
  assert.deepEqual(readStockPaperFee('-0.01'), { fee: null, configured: false });
  assert.deepEqual(readStockPaperFee('not-a-number'), { fee: null, configured: false });
});
