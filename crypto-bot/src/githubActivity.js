const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

export function validateGithubRepository(value) {
  const repository = String(value || '').trim();
  if (!repository) return '';
  if (repository.length > 140 || !REPOSITORY.test(repository) || repository.includes('..'))
    throw new Error('GitHub repository must be an exact public owner/repo name, not a URL or path.');
  return repository;
}

export async function fetchGithubActivity(repository, options = {}) {
  const exactRepository = validateGithubRepository(repository);
  if (!exactRepository) throw new Error('An exact GitHub owner/repo mapping is required.');
  const now = Number(options.now ?? Date.now());
  if (!Number.isFinite(now)) throw new Error('A valid observation time is required.');
  const since = new Date(now - 180 * 86400_000).toISOString();
  const recentCutoff = now - 90 * 86400_000;
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Math.min(15000, Number(options.timeoutMs) || 8000)));
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  if (options.token) headers.authorization = `Bearer ${String(options.token)}`;
  const rows = [];
  let pages = 0, truncated = false;
  try {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = `https://api.github.com/repos/${encodeURIComponent(exactRepository.split('/')[0])}/${encodeURIComponent(exactRepository.split('/')[1])}/commits?since=${encodeURIComponent(since)}&per_page=${PAGE_SIZE}&page=${page}`;
      const response = await fetchImpl(url, { headers, signal: controller.signal });
      if (!response.ok) return Object.freeze({ repository: exactRepository, status: response.status === 404 ? 'not_found_or_private' : [403, 429].includes(response.status) ? 'rate_limited_or_forbidden' : 'provider_error', httpStatus: response.status, observedAt: new Date(now).toISOString(), truncated: false, recentCommits: null, priorCommits: null, recentContributors: null, priorContributors: null });
      const data = await response.json();
      if (!Array.isArray(data)) return Object.freeze({ repository: exactRepository, status: 'invalid_response', httpStatus: response.status, observedAt: new Date(now).toISOString(), truncated: false, recentCommits: null, priorCommits: null, recentContributors: null, priorContributors: null });
      pages = page;
      rows.push(...data);
      if (data.length < PAGE_SIZE) break;
      if (page === MAX_PAGES) truncated = true;
    }
  } catch (error) {
    return Object.freeze({ repository: exactRepository, status: error?.name === 'AbortError' ? 'timeout' : 'request_failed', httpStatus: null, observedAt: new Date(now).toISOString(), truncated: false, recentCommits: null, priorCommits: null, recentContributors: null, priorContributors: null });
  } finally {
    clearTimeout(timeout);
  }
  const recent = [], prior = [];
  for (const row of rows) {
    const timestamp = Date.parse(row?.commit?.author?.date || row?.commit?.committer?.date || '');
    if (!Number.isFinite(timestamp) || timestamp > now || timestamp < now - 180 * 86400_000) continue;
    (timestamp >= recentCutoff ? recent : prior).push(row);
  }
  const summarize = (items) => new Set(items.map((item) => String(item?.author?.login || '').trim().toLowerCase()).filter(Boolean)).size;
  return Object.freeze({ repository: exactRepository, status: truncated ? 'partial_lower_bound' : 'available', httpStatus: 200,
    observedAt: new Date(now).toISOString(), from: since, recentFrom: new Date(recentCutoff).toISOString(), pages, truncated,
    recentCommits: recent.length, priorCommits: prior.length, recentContributors: summarize(recent), priorContributors: summarize(prior) });
}
