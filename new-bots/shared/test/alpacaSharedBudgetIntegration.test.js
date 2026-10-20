import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForAlpacaRequest as stocksGate } from '../../../stocks-bot/src/alpacaRequestGate.js';
import { waitForAlpacaRequest as sharedGate } from '../alpacaRequestGate.js';
import { requestAlpacaJson } from '../alpacaHttp.js';
import { createSharedAlpacaRequestGate } from '../alpacaSharedBudget.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Stocks and ETF HTTP callers share the same default coordinator in one process', () => {
  assert.equal(stocksGate, sharedGate);
});

test('a retry always acquires a fresh request slot after waiting', async () => {
  let at = 10000, requests = 0, grants = 0;
  const gate = async () => { grants++; return {}; };
  gate.defer = async () => {};
  await requestAlpacaJson('https://example.test', { 'APCA-API-KEY-ID': 'test' }, async () => ({
    ok: ++requests > 1, status: requests > 1 ? 200 : 429, headers: new Headers({ 'Retry-After': '1' }), json: async () => ({ ok: true }),
  }), [], 'Alpaca fixture', { requestGate: gate, clock: () => at, sleep: async ms => { at += ms; } });
  assert.equal(requests, 2);
  assert.equal(grants, 2);
});

test('final 429 is persisted for another worker; a budget deferral sends no HTTP request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'alpaca-http-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let at = 120000, calls = 0;
  const options = { directory, now: () => at, sleep: async ms => { at += ms; } };
  const one = createSharedAlpacaRequestGate(options), two = createSharedAlpacaRequestGate(options);
  const headers = { 'APCA-API-KEY-ID': 'test-no-real-account' }, metrics = [];
  const fetcher = async () => { calls++; return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '60' }) }; };
  await assert.rejects(requestAlpacaJson('https://example.test', headers, fetcher, metrics, 'Alpaca test',
    { maxAttempts: 1, requestGate: one, clock: () => at }), /HTTP 429/);
  await assert.rejects(requestAlpacaJson('https://example.test', headers, fetcher, metrics, 'Alpaca test',
    { requestGate: two, clock: () => at }), { code: 'ALPACA_PACING_DEFERRED' });
  assert.equal(calls, 1); assert.equal(metrics.length, 2);
  assert.equal(metrics[0].status, 429); assert.equal(metrics[1].requestAttempted, false);
  assert.equal(metrics[1].budgetRejection, 'ALPACA_PACING_DEFERRED');
});

test('a cooldown persistence failure cannot erase the observed HTTP attempt or trigger another request', async () => {
  const gate = async () => ({});
  gate.defer = async () => { throw Object.assign(new Error('storage unavailable'), { code: 'ALPACA_BUDGET_STORAGE_UNAVAILABLE' }); };
  const metrics = []; let calls = 0;
  await assert.rejects(requestAlpacaJson('https://example.test', { 'APCA-API-KEY-ID': 'fixture' }, async () => {
    calls++; return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '1' }) };
  }, metrics, 'Alpaca test', { requestGate: gate }), { code: 'ALPACA_BUDGET_STORAGE_UNAVAILABLE' });
  assert.equal(calls, 1); assert.equal(metrics.length, 1); assert.equal(metrics[0].status, 429);
});
