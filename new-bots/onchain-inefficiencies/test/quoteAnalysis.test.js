import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCycleQuote, compareSameBlockQuotes, evaluateCycleQuote, isUsableQuote } from '../src/quoteAnalysis.js';
import { decodeAmountsOut, encodeGetAmountsOut, fetchV2CycleQuotes, formatRawAmount } from '../src/evmRouterQuotes.js';

const now = Date.parse('2026-09-24T12:00:00.000Z');
const base = {
  chainId: 8453, blockNumber: 123, baseTokenAddress: `0x${'1'.repeat(40)}`,
  quoteTokenAddress: `0x${'2'.repeat(40)}`, quantity: 10_000, quoteTokenUsd: 1,
  feeBps: 5, slippageReserveBps: 5, gasUsd: 0.1, observedAt: new Date(now - 1000).toISOString()
};

test('only compares fresh same-chain, same-block, same-token, same-size quotes', () => {
  const buy = { ...base, side: 'buy', venue: 'Venue A', price: 0.0005 };
  const sell = { ...base, side: 'sell', venue: 'Venue B', price: 0.0006, observedAt: new Date(now - 1500).toISOString() };
  const result = compareSameBlockQuotes(buy, sell, { now, maxAgeMs: 5000, minNetUsd: 0.25 });
  assert.ok(result);
  assert.ok(result.estimatedNetUsd > 0.25);
  assert.equal(result.quoteSkewMs, 500);
  assert.equal(compareSameBlockQuotes(buy, { ...sell, blockNumber: 124 }, { now, maxAgeMs: 5000, minNetUsd: 0 }), null);
  assert.equal(compareSameBlockQuotes(buy, { ...sell, quantity: sell.quantity + 1 }, { now, maxAgeMs: 5000, minNetUsd: 0 }), null);
});

test('stale, future, and uneconomic quotes are rejected', () => {
  const buy = { ...base, side: 'buy', venue: 'A', price: 0.0005 };
  const sell = { ...base, side: 'sell', venue: 'B', price: 0.0006 };
  assert.equal(isUsableQuote({ ...buy, observedAt: new Date(now - 6000).toISOString() }, { now, maxAgeMs: 5000 }), false);
  assert.equal(isUsableQuote({ ...buy, observedAt: new Date(now + 1000).toISOString() }, { now, maxAgeMs: 5000 }), false);
  assert.equal(compareSameBlockQuotes(buy, { ...sell, price: 0.0005 }, { now, maxAgeMs: 5000, minNetUsd: 0 }), null);
});

const A = `0x${'1'.repeat(40)}`;
const B = `0x${'2'.repeat(40)}`;
const C = `0x${'3'.repeat(40)}`;
const w = (value) => BigInt(value).toString(16).padStart(64, '0');

test('encodes a circular Router02 exact-input quote and rejects an open route', () => {
  const data = encodeGetAmountsOut('1000000', [A, B, A]);
  assert.ok(data.startsWith('0xd06ca61f'));
  assert.throws(() => encodeGetAmountsOut('1000000', [A, B, C]), /returning to the start/);
  assert.deepEqual(decodeAmountsOut(`0x${w(32)}${w(3)}${w(100)}${w(90)}${w(105)}`, 3), ['100', '90', '105']);
});

test('formats route amounts with token decimals and reports unprofitable route economics', () => {
  assert.equal(formatRawAmount('99271150', 6), '99.27115');
  assert.equal(formatRawAmount('10000000000000000', 18), '0.01');
  const evaluation = evaluateCycleQuote({ id: 'loss', venue: 'Router', chainId: 1, blockNumber: 2,
    path: [A, B, A], tokenSymbols: ['USDC', 'USDT', 'USDC'], amountIn: '100', amountOut: '99.2',
    assumptions: 'test-only', inputUsd: 100, amountsRaw: ['100000000', '99000000', '99200000'],
    gasUsd: 25, slippageReserveBps: 100, observedAt: new Date(now).toISOString() }, { minNetUsd: 0.25 });
  assert.equal(evaluation.status, 'negative-gross-edge');
  assert.equal(evaluation.grossProfitUsd, -0.8);
  assert.equal(evaluation.slippageReserveUsd, 1);
  assert.equal(evaluation.estimatedNetUsd, -26.8);
  assert.equal(analyzeCycleQuote({ chainId: 1, blockNumber: 2, path: [A, B, A],
    amountsRaw: ['100000000', '99000000', '99200000'], inputUsd: 100, gasUsd: 25,
    slippageReserveBps: 100 }, { minNetUsd: 0.25 }), null);
});

test('pins all configured Router02 reads to one verified chain and block', async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const request = JSON.parse(init.body); calls.push(request);
    const result = request.method === 'eth_chainId' ? '0x1'
      : request.method === 'eth_blockNumber' ? '0x64'
        : request.method === 'eth_getBlockByNumber' ? { timestamp: `0x${Math.floor(now / 1000).toString(16)}` }
        : `0x${w(32)}${w(3)}${w(1000000)}${w(900000)}${w(1020000)}`;
    return { ok: true, json: async () => ({ result }) };
  };
  const routes = [{ id: 'cycle-a', venue: 'Router A', chainId: 1, routerAddress: C,
    path: [A, B, A], amountInRaw: '1000000', inputUsd: 100, gasUsd: 1, slippageReserveBps: 10 }];
  const result = await fetchV2CycleQuotes(routes, 'https://rpc.example', { fetcher, now });
  assert.equal(result.blockNumber, 100);
  assert.equal(result.quotes[0].amountsRaw.at(-1), '1020000');
  assert.equal(calls.at(-1).method, 'eth_call');
  assert.equal(calls.at(-1).params[1], '0x64');
  assert.ok(result.quotes[0].blockAgeMs >= 0 && result.quotes[0].blockAgeMs < 1000);
  const opportunity = analyzeCycleQuote(result.quotes[0], { minNetUsd: 0.25 });
  assert.equal(opportunity.estimatedNetUsd, 0.9);
  assert.equal(analyzeCycleQuote({ ...result.quotes[0], amountsRaw: ['bad', '0', '0'] }), null);
});

test('does not return a quote when the RPC is for a different chain', async () => {
  const fetcher = async (_url, init) => {
    const method = JSON.parse(init.body).method;
    return { ok: true, json: async () => ({ result: method === 'eth_chainId' ? '0xa' : '0x64' }) };
  };
  await assert.rejects(fetchV2CycleQuotes([{ chainId: 1, id: 'cycle', venue: 'Router', routerAddress: C,
    path: [A, B, A], amountInRaw: '1', inputUsd: 1, gasUsd: 0, slippageReserveBps: 0 }], 'https://rpc.example', { fetcher }), /does not match RPC chain 10/);
});
