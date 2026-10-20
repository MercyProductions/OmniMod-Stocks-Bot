// Extra public research calls share one queue. Legacy provider calls still have
// their own limits; this is deliberately not advertised as account-wide quota.
export function createResearchRequestQueue() {
  let tail = Promise.resolve();
  return (request, { spacingMs = 20000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) => {
    const work = tail.catch(() => {}).then(async () => {
      await sleep(spacingMs);
      return request();
    });
    tail = work;
    return work;
  };
}

const publicResearchQueue = createResearchRequestQueue();
export const paceCoinGeckoResearch = (tier, request, options) => tier === 'public'
  ? publicResearchQueue(request, options) : request();
