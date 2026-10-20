import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function runWriter(moduleUrl, dataDirectory, bar) {
  const source = `const store = await import(${JSON.stringify(moduleUrl)}); await store.recordMarketBars('alpaca-iex', [${JSON.stringify(bar)}]);`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, OMNIMOD_STOCKS_DATA_DIR: dataDirectory }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`writer exited ${code ?? signal}: ${stderr}`)));
  });
}

test('separate Stocks processes serialize bar writes without duplicates or lost symbols', async () => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-stocks-bars-lock-'));
  try {
    const moduleUrl = pathToFileURL(path.resolve('src/researchStore.js')).href;
    const timestamp = Math.floor(Date.parse('2026-07-21T15:00:00.000Z') / 1_000);
    const nvda = { symbol: 'NVDA', timestamp, open: 149, high: 151, low: 148, close: 150, volume: 1_000 };
    const aapl = { symbol: 'AAPL', timestamp, open: 200, high: 202, low: 199, close: 201, volume: 800 };
    await Promise.all([runWriter(moduleUrl, dataDirectory, nvda), runWriter(moduleUrl, dataDirectory, nvda), runWriter(moduleUrl, dataDirectory, aapl)]);
    const file = path.join(dataDirectory, 'research', 'bars', 'alpaca-iex', '2026-07-21.jsonl');
    const rows = (await fs.readFile(file, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.symbol).sort(), ['AAPL', 'NVDA']);
    await assert.rejects(fs.access(`${file}.lock`), { code: 'ENOENT' });
  } finally { await fs.rm(dataDirectory, { recursive: true, force: true }); }
});

test('Stocks bar writer waits for another process lock and writes after it is released', async () => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-stocks-bars-wait-'));
  try {
    const moduleUrl = pathToFileURL(path.resolve('src/researchStore.js')).href;
    const timestamp = Math.floor(Date.parse('2026-07-21T15:00:00.000Z') / 1_000);
    const bar = { symbol: 'MSFT', timestamp, open: 500, high: 502, low: 499, close: 501, volume: 500 };
    const file = path.join(dataDirectory, 'research', 'bars', 'alpaca-iex', '2026-07-21.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.lock`, JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() }));
    const writer = runWriter(moduleUrl, dataDirectory, bar);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(fs.access(file), { code: 'ENOENT' }, 'writer must not write while another owner holds the lock');
    await fs.unlink(`${file}.lock`);
    await writer;
    assert.equal((await fs.readFile(file, 'utf8')).trim().split(/\r?\n/).length, 1);
  } finally { await fs.rm(dataDirectory, { recursive: true, force: true }); }
});
