import { randomUUID } from 'node:crypto';
import { paths, readJson, writeJson } from './storage.js';

const TYPES = new Set(['earnings', 'guidance', 'fda_regulatory', 'merger_acquisition', 'contract', 'product', 'litigation', 'sec_filing', 'offering_dilution', 'buyback', 'insider', 'analyst', 'leadership', 'macro', 'other']);
const DIRECTIONS = new Set(['positive', 'negative', 'neutral', 'unknown']);
const EXPECTEDNESS = new Set(['scheduled', 'unexpected', 'unknown']);
const HORIZONS = new Set(['intraday', 'swing', 'long_term', 'unknown']);
const IMPACTS = new Set(['high', 'medium', 'low', 'unknown']);

function validate(row = {}) {
  const symbol = String(row.symbol || '').trim().toUpperCase();
  if (symbol !== '*' && !/^[A-Z][A-Z0-9.-]{0,10}$/.test(symbol)) throw new Error('Enter a U.S. ticker or * for a market-wide catalyst.');
  const reason = String(row.reason || '').trim();
  if (!reason || reason.length > 300) throw new Error('Catalyst description must contain 1–300 characters.');
  const startsAt = new Date(row.startsAt || Date.now());
  const endsAt = new Date(row.endsAt || Date.now() + 3_600_000);
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt) throw new Error('Catalyst end time must follow a valid start time.');
  let sourceUrl = String(row.sourceUrl || '').trim();
  if (sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      if (sourceUrl.length > 500 || url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error();
      sourceUrl = url.toString();
    } catch { throw new Error('Source must be an HTTPS URL up to 500 characters, without embedded credentials.'); }
  }
  return Object.freeze({
    id: String(row.id || randomUUID()), symbol, reason,
    eventType: TYPES.has(row.eventType) ? row.eventType : 'other',
    direction: DIRECTIONS.has(row.direction) ? row.direction : 'unknown',
    expectedness: EXPECTEDNESS.has(row.expectedness) ? row.expectedness : 'unknown',
    horizon: HORIZONS.has(row.horizon) ? row.horizon : 'unknown',
    impact: IMPACTS.has(row.impact) ? row.impact : 'unknown', sourceUrl,
    startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
    createdAt: String(row.createdAt || new Date().toISOString()), createdBy: String(row.createdBy || '')
  });
}

export function normalizeManualCatalyst(row) { return validate(row); }

export async function addManualCatalyst(guildId, input) {
  const store = await readJson(paths.manualCatalysts(guildId), { version: 1, events: [] });
  if (store?.version !== 1 || !Array.isArray(store.events)) throw new Error('Manual catalyst store has invalid structure; existing data was preserved.');
  const row = validate(input);
  store.events = [...store.events, row].slice(-500);
  store.updatedAt = new Date().toISOString();
  await writeJson(paths.manualCatalysts(guildId), store);
  return row;
}

export async function listManualCatalysts(guildId, now = new Date(), options = {}) {
  const store = await readJson(paths.manualCatalysts(guildId), { version: 1, events: [] });
  if (store?.version !== 1 || !Array.isArray(store.events)) throw new Error('Manual catalyst store has invalid structure; existing data was preserved.');
  const time = new Date(now).getTime();
  const retained = store.events.map(validate).filter((row) => new Date(row.endsAt).getTime() > time - 30 * 86_400_000);
  if (retained.length !== store.events.length) await writeJson(paths.manualCatalysts(guildId), { ...store, events: retained, updatedAt: new Date().toISOString() });
  return options.activeOnly === false ? retained : retained.filter((row) => new Date(row.startsAt).getTime() <= time && new Date(row.endsAt).getTime() >= time);
}

export async function clearManualCatalyst(guildId, idOrSymbol) {
  const store = await readJson(paths.manualCatalysts(guildId), { version: 1, events: [] });
  if (store?.version !== 1 || !Array.isArray(store.events)) throw new Error('Manual catalyst store has invalid structure; existing data was preserved.');
  const query = String(idOrSymbol || '').trim().toUpperCase();
  const before = store.events.length;
  store.events = store.events.filter((row) => String(row.id) !== String(idOrSymbol) && String(row.symbol).toUpperCase() !== query);
  store.updatedAt = new Date().toISOString();
  await writeJson(paths.manualCatalysts(guildId), store);
  return before - store.events.length;
}

export function catalystsForSymbol(events = [], symbol, now = new Date(), upcomingHours = 24 * 14) {
  const time = new Date(now).getTime();
  const cutoff = time + Math.max(0, Number(upcomingHours) || 0) * 3_600_000;
  return events.filter((row) => (row.symbol === '*' || row.symbol === String(symbol || '').toUpperCase())
    && new Date(row.startsAt).getTime() <= cutoff && new Date(row.endsAt).getTime() >= time)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt)).slice(0, 5);
}
