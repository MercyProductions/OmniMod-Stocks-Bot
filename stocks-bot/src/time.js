import { config } from './config.js';

export function localParts(date = new Date(), timezone = config.timezone) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const v = Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
  return { year: +v.year, month: +v.month, day: +v.day, hour: +v.hour % 24, minute: +v.minute, second: +v.second, weekday: v.weekday };
}

export function localDateKey(date = new Date(), timezone = config.timezone) {
  const p = localParts(date, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function localTimeLabel(date = new Date(), timezone = config.timezone) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

export function marketCloseTime(date = new Date()) {
  const parts = localParts(date, config.marketTimezone);
  const localCloseAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, marketCloseMinute(date) / 60, 0, 0);
  const guess = new Date(localCloseAsUtc);
  const guessParts = localParts(guess, config.marketTimezone);
  const representedGuess = Date.UTC(guessParts.year, guessParts.month - 1, guessParts.day, guessParts.hour, guessParts.minute, guessParts.second);
  const offsetMs = representedGuess - guess.getTime();
  return new Date(localCloseAsUtc - offsetMs);
}

function dateKeyUtc(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function observedFixedHoliday(year, month, day) {
  const holiday = new Date(Date.UTC(year, month - 1, day));
  const weekday = holiday.getUTCDay();
  if (weekday === 6) holiday.setUTCDate(holiday.getUTCDate() - 1);
  if (weekday === 0) holiday.setUTCDate(holiday.getUTCDate() + 1);
  return dateKeyUtc(holiday);
}

function nthWeekday(year, month, weekday, occurrence) {
  const date = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - date.getUTCDay() + 7) % 7;
  date.setUTCDate(1 + offset + (occurrence - 1) * 7);
  return dateKeyUtc(date);
}

function lastWeekday(year, month, weekday) {
  const date = new Date(Date.UTC(year, month, 0));
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() - weekday + 7) % 7);
  return dateKeyUtc(date);
}

function easterSunday(year) {
  const a = year % 19; const b = Math.floor(year / 100); const c = year % 100;
  const d = Math.floor(b / 4); const e = b % 4; const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = (h + l - 7 * m + 114) % 31 + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

export function usEquityHolidays(year) {
  const goodFriday = easterSunday(year); goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
  const holidays = [
    // NYSE does not observe a Saturday New Year's Day on the preceding Friday.
    ...(new Date(Date.UTC(year, 0, 1)).getUTCDay() === 6 ? [] : [observedFixedHoliday(year, 1, 1)]),
    nthWeekday(year, 1, 1, 3),
    nthWeekday(year, 2, 1, 3),
    dateKeyUtc(goodFriday),
    lastWeekday(year, 5, 1),
    observedFixedHoliday(year, 7, 4),
    nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 11, 4, 4),
    observedFixedHoliday(year, 12, 25)
  ];
  if (year >= 2022) holidays.push(observedFixedHoliday(year, 6, 19));
  return new Set(holidays);
}

// Recurring cash-equity early closes; extraordinary exchange closures require a calendar update.
// Source: https://www.nyse.com/trade/hours-calendars
export function marketCloseMinute(date = new Date()) {
  const p = localParts(date, config.marketTimezone);
  if (['Sat', 'Sun'].includes(p.weekday) || isUsEquityHoliday(date)) return 960;
  const thanksgiving = Number(nthWeekday(p.year, 11, 4, 4).slice(-2));
  const early = (p.month === 11 && p.day === thanksgiving + 1)
    || (p.month === 12 && p.day === 24)
    || (p.month === 7 && p.day === 3);
  return early ? 780 : 960;
}

export function isUsEquityHoliday(date = new Date()) {
  const parts = localParts(date, config.marketTimezone);
  const key = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  return usEquityHolidays(parts.year).has(key) || usEquityHolidays(parts.year + 1).has(key);
}

export function marketSession(date = new Date()) {
  const p = localParts(date, config.marketTimezone);
  if (['Sat', 'Sun'].includes(p.weekday)) return { state: 'closed', label: 'Weekend', openForDiscovery: false, monitorable: false };
  if (isUsEquityHoliday(date)) return { state: 'closed', label: 'U.S. equity-market holiday', openForDiscovery: false, monitorable: false };
  const minute = p.hour * 60 + p.minute;
  if (minute < 240) return { state: 'closed', label: 'Overnight', openForDiscovery: false, monitorable: false };
  if (minute < 570) return { state: 'pre_market', label: 'Pre-market monitoring', openForDiscovery: false, monitorable: true };
  if (minute < marketCloseMinute(date)) return { state: 'regular', label: 'Regular session', openForDiscovery: true, monitorable: true };
  if (minute < 1200) return { state: 'after_hours', label: 'After-hours', openForDiscovery: false, monitorable: true };
  return { state: 'closed', label: 'Market closed', openForDiscovery: false, monitorable: false };
}

export function shouldScanConfiguredUniverse(session, { allowNewSignals = false, discoverPremarket = false } = {}) {
  return Boolean(allowNewSignals || (discoverPremarket && session?.state === 'pre_market'));
}

export function isDailyDiscoveryTime(now = new Date(), settings = {}) {
  const p = localParts(now, config.timezone);
  return p.hour === Number(settings.dailyHour ?? config.dailyHour) && p.minute === Number(settings.dailyMinute ?? config.dailyMinute);
}

export function isDailyDiscoveryDue(now = new Date(), settings = {}) {
  const p = localParts(now, config.timezone);
  const scheduled = Number(settings.dailyHour ?? config.dailyHour) * 60 + Number(settings.dailyMinute ?? config.dailyMinute);
  return !['Sat', 'Sun'].includes(p.weekday) && p.hour * 60 + p.minute >= scheduled;
}

export function isDailyReviewDue(now = new Date()) {
  const p = localParts(now, config.marketTimezone);
  return !['Sat', 'Sun'].includes(p.weekday) && p.hour * 60 + p.minute >= 20 * 60 + 5;
}
