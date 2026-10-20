import { randomUUID } from 'node:crypto';
import { paths, readJson, writeJson } from './storage.js';

const EVENT_TYPES = new Set(['token_unlock', 'exchange_listing', 'exchange_delisting', 'network_upgrade', 'protocol_incident', 'regulatory', 'governance', 'macro', 'other']);
const DIRECTIONS = new Set(['positive', 'negative', 'neutral', 'unknown']);
const EXPECTEDNESS = new Set(['scheduled', 'unexpected', 'unknown']);
const HORIZONS = new Set(['intraday', 'swing', 'long_term', 'unknown']);
const IMPACTS = new Set(['high', 'medium', 'low', 'unknown']);

export function normalizedEvent(row = {}) {
  let sourceUrl = String(row.sourceUrl || '').trim();
  if (sourceUrl) {
    if (sourceUrl.length > 500) sourceUrl = '';
  }
  if (sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      sourceUrl = parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password ? parsed.toString() : '';
    } catch { sourceUrl = ''; }
  }
  const startsAt = new Date(row.startsAt || Date.now());
  const endsAt = new Date(row.endsAt || Date.now() + 3_600_000);
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt) throw new Error('Catalyst end time must be later than a valid start time.');
  return {
    id: String(row.id || randomUUID()), symbol: String(row.symbol || '*').trim().toUpperCase() || '*',
    severity: ['caution', 'observe'].includes(row.severity) ? row.severity : 'block', reason: String(row.reason || 'Crypto market event').slice(0, 300),
    eventType: EVENT_TYPES.has(row.eventType) ? row.eventType : 'other', direction: DIRECTIONS.has(row.direction) ? row.direction : 'unknown',
    expectedness: EXPECTEDNESS.has(row.expectedness) ? row.expectedness : 'unknown', horizon: HORIZONS.has(row.horizon) ? row.horizon : 'unknown',
    impact: IMPACTS.has(row.impact) ? row.impact : 'unknown', sourceUrl,
    startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
    createdAt: String(row.createdAt || new Date().toISOString()), createdBy: String(row.createdBy || '')
  };
}

export async function listEventRisks(guildId, now = new Date(), options = {}) {
  const store = await readJson(paths.eventRisk(guildId), { version: 1, events: [] });
  const rows = (store.events || []).map(normalizedEvent);
  const retained = rows.filter((row) => new Date(row.endsAt).getTime() > new Date(now).getTime() - 7 * 86_400_000);
  if (retained.length !== rows.length) await writeJson(paths.eventRisk(guildId), { version: 1, events: retained, updatedAt: new Date().toISOString() });
  return options.activeOnly === false ? retained : retained.filter((row) =>
    new Date(row.startsAt).getTime() <= new Date(now).getTime() && new Date(row.endsAt).getTime() >= new Date(now).getTime());
}

export async function addEventRisk(guildId, event) {
  const store = await readJson(paths.eventRisk(guildId), { version: 1, events: [] });
  const row = normalizedEvent(event);
  if (event?.sourceUrl && !row.sourceUrl) throw new Error('Catalyst source must be a valid HTTPS URL up to 500 characters, without embedded credentials.');
  store.events = [...(store.events || []), row].slice(-500);
  store.updatedAt = new Date().toISOString();
  await writeJson(paths.eventRisk(guildId), store);
  return row;
}

export async function clearEventRisk(guildId, idOrSymbol) {
  const store = await readJson(paths.eventRisk(guildId), { version: 1, events: [] });
  const query = String(idOrSymbol || '').toUpperCase();
  const before = (store.events || []).length;
  store.events = (store.events || []).filter((row) => String(row.id) !== idOrSymbol && String(row.symbol).toUpperCase() !== query);
  store.updatedAt = new Date().toISOString();
  await writeJson(paths.eventRisk(guildId), store);
  return before - store.events.length;
}

export function evaluateEventRisk(asset, events = [], now = new Date()) {
  const symbol = String(asset?.symbol || '').toUpperCase();
  const current = new Date(now).getTime();
  const relevant = events.filter((row) => (row.symbol === '*' || row.symbol === symbol)
    && new Date(row.startsAt).getTime() <= current && new Date(row.endsAt).getTime() >= current);
  return {
    blocked: relevant.some((row) => row.severity === 'block'), caution: relevant.some((row) => row.severity === 'caution'),
    observe: relevant.some((row) => row.severity === 'observe'), events: relevant, reasons: relevant.map((row) => row.reason)
  };
}
