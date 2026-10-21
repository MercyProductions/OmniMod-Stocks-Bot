import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('npm test isolates Stocks configuration from the operator credential file',async()=>{
  const file=process.env.OMNIMOD_STOCKS_ENV_FILE;
  assert.ok(file);
  assert.ok(path.resolve(file).startsWith(path.resolve(os.tmpdir())+path.sep));
  assert.equal(fs.existsSync(file),false);
  process.env.ALPACA_API_KEY_ID='isolated-mock-key';
  process.env.ALPACA_API_SECRET_KEY='isolated-mock-secret';
  const {config}=await import('../src/config.js');
  // Compare booleans so a failed isolation check cannot print a real credential as an assertion value.
  assert.equal(config.alpacaKeyId==='isolated-mock-key',true);
  assert.equal(config.alpacaSecretKey==='isolated-mock-secret',true);
});
