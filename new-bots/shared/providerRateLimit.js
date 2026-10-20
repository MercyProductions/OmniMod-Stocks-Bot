/** Parse only limits explicitly returned by an HTTP provider response. */
export function readProviderRateLimit(headers) {
  const read = (...names) => {
    for (const name of names) {
      let value = null;
      if (typeof headers?.get === 'function') value = headers.get(name);
      else {
        const key = Object.keys(headers ?? {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
        if (key) value = headers[key];
      }
      if (value != null && String(value).trim() !== '') return String(value).trim();
    }
    return null;
  };
  const number = (value) => {
    if (value == null) return null;
    const parsed = Number.parseFloat(String(value).split(';', 1)[0]);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const limitRaw = read('RateLimit-Limit', 'X-RateLimit-Limit', 'X-Rate-Limit-Limit');
  const remainingRaw = read('RateLimit-Remaining', 'X-RateLimit-Remaining', 'X-Rate-Limit-Remaining');
  const usedRaw = read('RateLimit-Used', 'X-RateLimit-Used', 'X-Rate-Limit-Used');
  const reset = read('RateLimit-Reset', 'X-RateLimit-Reset', 'X-Rate-Limit-Reset');
  const retryAfter = read('Retry-After');
  const limit = number(limitRaw);
  const remaining = number(remainingRaw);
  const used = number(usedRaw) ?? (limit !== null && remaining !== null ? Math.max(0, limit - remaining) : null);
  if (limit === null && remaining === null && used === null && reset === null && retryAfter === null) return null;
  return {
    limit,
    remaining,
    used,
    utilizationPct: limit > 0 && used !== null ? Number(Math.min(100, used / limit * 100).toFixed(2)) : null,
    reset,
    retryAfter,
  };
}
