import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGithubActivity, validateGithubRepository } from '../src/githubActivity.js';

const NOW = Date.parse('2026-09-29T12:00:00Z');
function commit(date, login) { return { commit: { author: { date } }, author: login ? { login } : null }; }

test('GitHub thesis mapping requires an exact owner/repo and rejects URLs or paths', () => {
  assert.equal(validateGithubRepository('Uniswap/v4-core'), 'Uniswap/v4-core');
  assert.equal(validateGithubRepository(''), '');
  for (const value of ['https://github.com/a/b', 'a/b/tree/main', '../repo/name', 'a//b', 'a/b?x=y'])
    assert.throws(() => validateGithubRepository(value), /exact public owner\/repo/);
});

test('GitHub activity uses two 90-day windows and counts only identified public contributors', async () => {
  const calls = [];
  const result = await fetchGithubActivity('owner/repo', { now: NOW, fetch: async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => [
      commit('2026-09-20T00:00:00Z', 'alice'), commit('2026-08-01T00:00:00Z', 'alice'),
      commit('2026-06-01T00:00:00Z', 'bob'), commit('2026-04-01T00:00:00Z', null),
      commit('2026-03-01T00:00:00Z', 'old'), commit('2026-10-01T00:00:00Z', 'future'), commit('invalid', 'bad')
    ] }; } });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/api\.github\.com\/repos\/owner\/repo\/commits\?/);
  assert.equal(calls[0].init.headers.accept, 'application/vnd.github+json');
  assert.equal(result.status, 'available');
  assert.equal(result.recentCommits, 2);
  assert.equal(result.priorCommits, 1);
  assert.equal(result.recentContributors, 1);
  assert.equal(result.priorContributors, 1);
});

test('GitHub activity caps pagination and labels results as lower bounds', async () => {
  let calls = 0;
  const result = await fetchGithubActivity('owner/repo', { now: NOW, fetch: async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => Array.from({ length: 100 }, (_, index) => commit(`2026-09-${String(28 - index % 28).padStart(2, '0')}T00:00:00Z`, `user-${index}`)) };
  } });
  assert.equal(calls, 5);
  assert.equal(result.pages, 5);
  assert.equal(result.truncated, true);
  assert.equal(result.status, 'partial_lower_bound');
});

test('GitHub errors return explicit unavailable statuses and never return response bodies', async () => {
  const denied = await fetchGithubActivity('owner/repo', { now: NOW, token: 'test-token', fetch: async (_url, init) => {
    assert.equal(init.headers.authorization, 'Bearer test-token');
    return { ok: false, status: 403, text: async () => 'sensitive body' };
  } });
  assert.equal(denied.status, 'rate_limited_or_forbidden');
  assert.equal(denied.httpStatus, 403);
  assert.equal('body' in denied, false);
  const overloaded = await fetchGithubActivity('owner/repo', { now: NOW, fetch: async () => ({ ok: false, status: 429 }) });
  assert.equal(overloaded.status, 'rate_limited_or_forbidden');
  const failure = await fetchGithubActivity('owner/repo', { now: NOW, fetch: async () => { throw new Error('network detail'); } });
  assert.equal(failure.status, 'request_failed');
});
