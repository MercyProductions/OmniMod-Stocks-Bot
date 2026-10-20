import test from 'node:test';
import assert from 'node:assert/strict';

test('concurrent SEC fundamentals requests coalesce each identical cold-cache fetch', async () => {
  process.env.SEC_USER_AGENT = 'OmniMod research test contact@example.invalid';
  const { fetchIssuerAnnualFundamentals } = await import('../src/eventIntelligence.js');
  const requests = [];
  const requestTimes = [];
  const fetcher = async (url) => {
    requests.push(String(url));
    requestTimes.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (String(url).includes('company_tickers.json')) {
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({
        0: { ticker: 'DUPL', cik_str: 12345 },
        1: { ticker: 'DUP2', cik_str: 67890 },
      }) };
    }
    // Simulate the event loop being paused while a SEC request is starting.
    // Queued requests must be spaced from the actual start after this pause.
    if (requests.length === 2) {
      const until = Date.now() + 150;
      while (Date.now() < until) { /* deterministic event-loop stall */ }
    }
    if (String(url).includes('/submissions/')) {
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ filings: { recent: {} } }) };
    }
    if (String(url).includes('/companyfacts/')) {
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ facts: { 'us-gaap': {} } }) };
    }
    throw new Error(`Unexpected fixture URL: ${url}`);
  };
  const metricsA = { requests: [] };
  const metricsB = { requests: [] };
  const [a, b] = await Promise.all([
    fetchIssuerAnnualFundamentals(['DUPL', 'DUP2'], new Date('2026-09-30T15:00:00Z'), metricsA, fetcher),
    fetchIssuerAnnualFundamentals(['DUPL', 'DUP2'], new Date('2026-09-30T15:00:00Z'), metricsB, fetcher),
  ]);
  assert.equal(a.length, 2);
  assert.equal(b.length, 2);
  assert.equal(requests.length, 5, 'ticker map, submissions and facts should each be fetched once per issuer');
  assert.equal(metricsA.requests.length + metricsB.requests.length, 5, 'telemetry should describe actual network attempts only');
  for (let index = 1; index < requestTimes.length; index++)
    assert.ok(requestTimes[index] - requestTimes[index - 1] >= 90,
      `SEC subdomains share one ten-per-second start pacer (gap ${requestTimes[index] - requestTimes[index - 1]}ms)`);
});
