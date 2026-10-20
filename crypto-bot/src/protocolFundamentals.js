const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DAY = 86_400_000;

export function validateProtocolSlug(value) {
  const slug = String(value || '').trim().toLowerCase();
  if (!slug) return '';
  if (slug.length > 64 || !SLUG.test(slug)) throw new Error('Protocol slug must be an exact DeFiLlama slug containing lowercase letters, numbers, and single hyphens.');
  return slug;
}

function pointsFrom(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.tvl) ? payload.tvl : [];
  const numeric = (value) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  return rows.map((row) => ({ date: numeric(row?.date ?? row?.timestamp), value: numeric(row?.totalLiquidityUSD ?? row?.tvl ?? row?.value) }))
    .filter((row) => row.date !== null && row.value !== null && row.value >= 0)
    .map((row) => ({ ...row, date: row.date < 10_000_000_000 ? row.date * 1000 : row.date }))
    .sort((a, b) => a.date - b.date);
}

function latestTvlFacts(payload, now = Date.now()) {
  const points = pointsFrom(payload);
  const latest = [...points].reverse().find((point) => point.date <= now);
  if (!latest) return [];
  const facts = [{ key: 'protocol_tvl_usd', label: 'Protocol TVL (USD; price-sensitive)', value: latest.value, unit: 'USD', periodEnd: new Date(latest.date).toISOString() }];
  for (const days of [30, 90, 365]) {
    const target = latest.date - days * DAY;
    const prior = [...points].reverse().find((point) => point.date <= target);
    if (!prior || prior.value <= 0) continue;
    const actualDays = Math.round((latest.date - prior.date) / DAY);
    facts.push({ key: `protocol_tvl_change_${days}d`, label: `Protocol TVL change (${days}d target; ${actualDays}d observed)`, value: (latest.value / prior.value - 1) * 100,
      unit: 'percent', periodEnd: new Date(latest.date).toISOString() });
  }
  return facts;
}

async function jsonRequest(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response?.ok) throw new Error(`HTTP ${Number(response?.status) || 0}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

function periodEnd(period) {
  const text = String(period || '').trim();
  const quarter = text.match(/^(\d{4})[- ]?Q([1-4])$/i);
  if (quarter) return Date.UTC(Number(quarter[1]), Number(quarter[2]) * 3, 0);
  const month = text.match(/^(\d{4})-(\d{2})$/);
  if (month) return Date.UTC(Number(month[1]), Number(month[2]), 0);
  const year = text.match(/^(\d{4})$/);
  if (year) return Date.UTC(Number(year[1]), 11, 31);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function latestFinancialFacts(payload) {
  const priority = { yearly: 1, quarterly: 2, monthly: 3 };
  const periods = Object.entries(payload?.aggregates || {}).flatMap(([granularity, rows]) =>
    ['yearly', 'quarterly', 'monthly'].includes(granularity) && rows && typeof rows === 'object'
      ? Object.entries(rows).map(([period, metrics]) => ({ period, metrics, granularity, end: periodEnd(period) })) : [])
    .filter((row) => Number.isFinite(row.end))
    .sort((a, b) => b.end - a.end || priority[b.granularity] - priority[a.granularity]);
  const result = [];
  for (const { period, metrics, granularity } of periods.slice(0, 1)) {
    for (const [line, key, label] of [
      ['Gross Protocol Revenue', 'protocol_gross_revenue_usd', 'Gross protocol revenue'],
      ['Token Holder Net Income', 'token_holder_net_income_usd', 'Token-holder net income'],
      ['Earnings', 'protocol_earnings_usd', 'Protocol earnings']
    ]) {
      const raw = metrics?.[line]?.value;
      const value = raw === null || raw === undefined || raw === '' ? null : Number(raw);
      if (Number.isFinite(value)) result.push({ key, label: `${label} (${granularity}; ${period})`, value, unit: 'USD', periodEnd: String(period) });
    }
  }
  return result;
}

function usageFacts(payload, dataType) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const definitions = dataType === 'dailyActiveUsers'
    ? { total24h: ['protocol_active_users_24h', 'Protocol-reported active users (24h aggregate)', 'users'],
      total7d: ['protocol_active_users_7d', 'Protocol-reported active users (7d aggregate)', 'users'],
      total30d: ['protocol_active_users_30d', 'Protocol-reported active users (30d aggregate)', 'users'],
      total1y: ['protocol_active_users_1y', 'Protocol-reported active users (1y aggregate)', 'users'] }
    : { total24h: ['protocol_transactions_24h', 'Protocol-reported transactions (24h aggregate)', 'transactions'],
      total7d: ['protocol_transactions_7d', 'Protocol-reported transactions (7d aggregate)', 'transactions'],
      total30d: ['protocol_transactions_30d', 'Protocol-reported transactions (30d aggregate)', 'transactions'],
      total1y: ['protocol_transactions_1y', 'Protocol-reported transactions (1y aggregate)', 'transactions'] };
  return Object.entries(definitions).flatMap(([field, [key, label, unit]]) => {
    const raw = payload[field];
    const value = raw === null || raw === undefined || raw === '' ? null : Number(raw);
    return Number.isFinite(value) && value >= 0 ? [{ key, label, value, unit }] : [];
  });
}

function usageStatus(results, activeUsers, transactions) {
  const successful = results.filter((row) => row.status === 'fulfilled').length;
  const failed = results.length - successful;
  const available = activeUsers.length + transactions.length;
  if (failed === results.length) return 'request failed';
  if (failed) return `partial; ${available} reported fields; ${failed} request(s) failed`;
  if (available) return `available; ${available} reported fields`;
  return 'no supported numeric fields';
}

function emissionSummary(payload, now) {
  if (!payload || typeof payload !== 'object') return { available: false, note: 'No emission schedule returned.' };
  let body = payload.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || typeof body !== 'object') return { available: false, note: 'Provider response did not contain a parseable emission schedule.' };
  const numeric = (value) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  const supply = body.supplyMetrics || {};
  const allocations = body.documentedData?.tokenAllocation || {};
  const pickAllocations = (value) => Object.fromEntries(Object.entries(value || {}).filter(([, amount]) => amount !== null && amount !== undefined && amount !== '' && Number.isFinite(Number(amount))).slice(0, 8).map(([name, amount]) => [String(name).slice(0, 48), Number(amount)]));
  const events = Array.isArray(body.metadata?.events) ? body.metadata.events : [];
  const future = events.filter((event) => event.timestamp !== null && event.timestamp !== undefined && event.timestamp !== ''
      && Number.isFinite(Number(event.timestamp)) && Number(event.timestamp) * 1000 >= now)
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp)).slice(0, 3)
    .map((event) => ({ date: new Date(Number(event.timestamp) * 1000).toISOString(), category: String(event.category || '').slice(0, 48), unlockType: String(event.unlockType || '').slice(0, 32),
      description: String(event.description || '').replace(/[\r\n]+/g, ' ').slice(0, 100), tokenAmount: Array.isArray(event.noOfTokens) && event.noOfTokens.length > 0
        && event.noOfTokens.every((value) => numeric(value) !== null) ? event.noOfTokens.reduce((sum, value) => sum + Number(value), 0) : null }));
  return {
    available: true, name: String(body.name || '').slice(0, 80), lastModified: String(payload.lastModified || '').slice(0, 40),
    supplyMetrics: { maxSupply: numeric(supply.maxSupply), adjustedSupply: numeric(supply.adjustedSupply), tbdAmount: numeric(supply.tbdAmount),
      incentiveAmount: numeric(supply.incentiveAmount), nonIncentiveAmount: numeric(supply.nonIncentiveAmount) },
    allocation: { current: pickAllocations(allocations.current), final: pickAllocations(allocations.final) },
    upcomingEvents: future, eventCount: events.length,
    note: events.length ? `Provider schedule contains ${events.length} documented event(s); showing up to three dated upcoming events.` : 'Provider emission record has no dated events.'
  };
}

export async function fetchProtocolFundamentals(slugInput, options = {}) {
  const slug = validateProtocolSlug(slugInput);
  if (!slug) throw new Error('An exact protocol slug is required.');
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable in this runtime.');
  const timeoutMs = Math.max(500, Math.min(15_000, Number(options.timeoutMs) || 8_000));
  const now = Number(options.now) || Date.now();
  let tvlFacts = [], tvlError = '', protocolId = '';
  try {
    const protocolPayload = await jsonRequest(`https://api.llama.fi/protocol/${encodeURIComponent(slug)}`, fetchImpl, timeoutMs);
    tvlFacts = latestTvlFacts(protocolPayload, now);
    protocolId = typeof protocolPayload?.id === 'string' && protocolPayload.id.length <= 120 ? protocolPayload.id : '';
  }
  catch (error) { tvlError = error?.name === 'AbortError' ? 'timeout' : String(error?.message || 'provider error').slice(0, 60); }

  const apiKey = String(options.apiKey || '').trim();
  let financialFacts = [], financialStatus = apiKey ? 'unavailable' : 'not configured';
  let usageMetrics = [], usageStatusText = apiKey ? 'unavailable' : 'not configured';
  let emissions = { available: false, note: apiKey ? 'Not retrieved.' : 'Paid API key not configured.' };
  let security = { status: !options.hacksEnabled ? 'not enabled' : !apiKey ? 'paid API key not configured' : !protocolId ? 'protocol identity unavailable' : 'unavailable', protocolId, observedAt: new Date(now).toISOString(), incidentCount: null, events: [] };
  if (apiKey) {
    const root = `https://pro-api.llama.fi/${encodeURIComponent(apiKey)}`;
    const [financial, emission, activeUsers, transactions, hacks] = await Promise.allSettled([
      jsonRequest(`${root}/api/v2/metrics/financial-statement/protocol/${encodeURIComponent(slug)}`, fetchImpl, timeoutMs),
      jsonRequest(`${root}/api/emission/${encodeURIComponent(slug)}`, fetchImpl, timeoutMs),
      jsonRequest(`${root}/api/v2/metrics/active-users/protocol/${encodeURIComponent(slug)}?dataType=dailyActiveUsers`, fetchImpl, timeoutMs),
      jsonRequest(`${root}/api/v2/metrics/active-users/protocol/${encodeURIComponent(slug)}?dataType=dailyTransactionCount`, fetchImpl, timeoutMs),
      options.hacksEnabled && protocolId ? jsonRequest(`${root}/api/hacks`, fetchImpl, timeoutMs) : Promise.resolve(null)
    ]);
    if (financial.status === 'fulfilled') {
      financialFacts = latestFinancialFacts(financial.value);
      financialStatus = financialFacts.length ? 'available' : 'no supported numeric fields';
    } else financialStatus = financial.reason?.name === 'AbortError' ? 'timeout' : 'request failed';
    emissions = emission.status === 'fulfilled' ? emissionSummary(emission.value, now)
      : { available: false, note: emission.reason?.name === 'AbortError' ? 'Paid API request timed out.' : 'Paid API request failed.' };
    const userFacts = activeUsers.status === 'fulfilled' ? usageFacts(activeUsers.value, 'dailyActiveUsers') : [];
    const transactionFacts = transactions.status === 'fulfilled' ? usageFacts(transactions.value, 'dailyTransactionCount') : [];
    usageMetrics = [...userFacts, ...transactionFacts];
    usageStatusText = usageStatus([activeUsers, transactions], userFacts, transactionFacts);
    if (options.hacksEnabled && protocolId) {
      if (hacks.status !== 'fulfilled' || !Array.isArray(hacks.value)) security.status = hacks.reason?.name === 'AbortError' ? 'timeout' : 'request failed';
      else {
        const matches = hacks.value.filter((event) => String(event?.defillamaId || '') === protocolId).map((event) => {
          const dateValue = Number(event.date);
          const time = Number.isFinite(dateValue) ? (dateValue < 10_000_000_000 ? dateValue * 1000 : dateValue) : Date.parse(event.date || '');
          return { time, date: Number.isFinite(time) ? new Date(time).toISOString() : '', classification: String(event.classification || '').replace(/[\r\n]+/g, ' ').slice(0, 48),
            technique: String(event.technique || '').replace(/[\r\n]+/g, ' ').slice(0, 80), amountUsd: event.amount === null || event.amount === undefined || !Number.isFinite(Number(event.amount)) ? null : Number(event.amount),
            chains: (Array.isArray(event.chain) ? event.chain : []).slice(0, 5).map((chain) => String(chain).replace(/[\r\n]+/g, ' ').slice(0, 32)), bridgeHack: Boolean(event.bridgeHack),
            source: /^https:\/\//i.test(String(event.source || '')) ? String(event.source).replace(/[\r\n]+/g, '').slice(0, 240) : '' };
        }).filter((event) => event.date && event.time <= now).sort((a, b) => b.time - a.time);
        security = { status: matches.length ? 'available' : 'no matched incidents', protocolId, observedAt: new Date(now).toISOString(), incidentCount: matches.length,
          events: matches.slice(0, 5).map(({ time, ...event }) => event) };
      }
    }
  }
  return {
    slug, observedAt: new Date(now).toISOString(), tvlFacts,
    tvlStatus: tvlFacts.length ? `available; latest point ${Math.floor((now - Date.parse(tvlFacts[0].periodEnd)) / DAY)}d old` : tvlError ? `unavailable (${tvlError})` : 'no dated TVL points',
    financialFacts, financialStatus, usageFacts: usageMetrics, usageStatus: usageStatusText, emissions, security,
    note: 'TVL changes can reflect token prices as well as deposits/withdrawals. Provider metrics do not establish token value capture or investment merit.'
  };
}
