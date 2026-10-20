import test from 'node:test';
import assert from 'node:assert/strict';
import { readProviderRateLimit } from '../providerRateLimit.js';

test('parses returned standard and X-prefixed quota headers without assuming absent limits', () => {
  assert.deepEqual(readProviderRateLimit(new Headers({ 'ratelimit-limit': '120;w=60', 'ratelimit-remaining': '90', 'ratelimit-reset': '12' })), {
    limit: 120, remaining: 90, used: 30, utilizationPct: 25, reset: '12', retryAfter: null,
  });
  assert.deepEqual(readProviderRateLimit({ 'X-RateLimit-Limit': '50', 'X-RateLimit-Used': '7', 'Retry-After': '3' }), {
    limit: 50, remaining: null, used: 7, utilizationPct: 14, reset: null, retryAfter: '3',
  });
  assert.equal(readProviderRateLimit(new Headers()), null);
  assert.equal(readProviderRateLimit({ 'X-RateLimit-Limit': 'invalid', 'X-RateLimit-Remaining': '-1' }), null);
});
