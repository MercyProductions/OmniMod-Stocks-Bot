import { isIntradayPrimaryResearch } from '../../shared/signalResearch.js';

const OWNERS = new Set(['stocks', 'crypto', 'futures', 'options', 'etfs-etps']);

/**
 * Match operator-declared related symbols to an FX pair. These are advisory
 * cross-market observations only: native direction is never translated into
 * an FX-pair direction or passed to the entry strategy/risk gate.
 */
export function mapForexPrimaryResearch(instruments, records, mapping = {}) {
  if (!Array.isArray(instruments) || !Array.isArray(records) || !mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new TypeError('Forex instruments, research records, and a pair-to-symbol mapping are required.');
  }
  const normalizedMapping = new Map();
  for (const [pairInput, symbolsInput] of Object.entries(mapping)) {
    const pair = String(pairInput).trim().toUpperCase();
    if (!/^[A-Z]{3}_[A-Z]{3}$/.test(pair) || !Array.isArray(symbolsInput)) {
      throw new TypeError('Forex research mapping must map BASE_QUOTE pairs to symbol arrays.');
    }
    const symbols = symbolsInput.map((value) => String(value).trim().toUpperCase());
    if (symbols.some((symbol) => !/^(?:[A-Z0-9][A-Z0-9.-]{0,9}|[A-Z]{3}_[A-Z]{3})$/.test(symbol))) {
      throw new TypeError(`Forex research mapping for ${pair} contains an invalid symbol.`);
    }
    normalizedMapping.set(pair, new Set(symbols));
  }

  return instruments.map((instrumentInput) => {
    const instrument = String(instrumentInput).trim().toUpperCase();
    const symbols = normalizedMapping.get(instrument) ?? new Set();
    const latest = new Map();
    for (const record of records) {
      const symbol = String(record?.symbol ?? '').trim().toUpperCase();
      const exposureKey = String(record?.exposureKey ?? '').trim().toUpperCase();
      if ((instrument !== exposureKey && !symbols.has(symbol) && !symbols.has(exposureKey)) || !OWNERS.has(record?.owner) || record.status !== 'active'
        || !isIntradayPrimaryResearch(record) || record.executable !== false || record.paperOnly !== true) continue;
      const observed = Date.parse(record.observedAt);
      if (!Number.isFinite(observed)) continue;
      const key = `${record.owner}:${symbol}`;
      const previous = latest.get(key);
      if (!previous || observed > Date.parse(previous.observedAt)) latest.set(key, record);
    }
    return [instrument, [...latest.values()].map((record) => ({
      id: record.id,
      owner: record.owner,
      symbol: String(record.symbol).toUpperCase(),
      direction: record.direction,
      observedAt: record.observedAt,
      strategyId: record.strategyId,
      catalystContextStatus: record.catalystContextStatus || 'unknown',
      catalystContext: (record.catalystContext || []).slice(0, 2),
      executable: false,
      paperOnly: true,
      interpretation: 'native direction; not translated to the FX pair',
    }))];
  });
}

export function parseForexPrimarySignalMap(raw = '{}') {
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new TypeError('FOREX_PRIMARY_SIGNAL_MAP_JSON must contain a JSON object.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('FOREX_PRIMARY_SIGNAL_MAP_JSON must contain a JSON object.');
  }
  return parsed;
}
