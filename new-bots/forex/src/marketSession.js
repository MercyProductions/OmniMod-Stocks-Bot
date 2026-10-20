const TIME_ZONE = 'America/New_York';
const TRY_TIME_ZONE = 'Europe/Berlin';
const NZD_TIME_ZONE = 'Pacific/Auckland';
const DAY_MS = 24 * 60 * 60_000;
const weekdayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map();

function localParts(epochMs, timeZone = TIME_ZONE) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), weekday: weekdayIndex[parts.weekday], hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

function localDateTimeToUtc(date, hour, minute, timeZone = TIME_ZONE) {
  const [year, month, day] = date.split('-').map(Number);
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute);
  let guess = desiredUtc;
  for (let i = 0; i < 3; i += 1) {
    const parts = localParts(guess, timeZone);
    const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const offset = representedAsUtc - Math.floor(guess / 1000) * 1000;
    guess = desiredUtc - offset;
  }
  return guess;
}

function dateString({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addCalendarDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

/** OANDA US FX hours, including instrument-specific TRY and NZD schedules. */
export function getForexMarketSession(now = Date.now(), { closedSessionDates = [], earlyClosesEt = {}, instrument = '' } = {}) {
  if (!Number.isFinite(now)) throw new TypeError('Forex session time must be a finite epoch timestamp');
  if (!Array.isArray(closedSessionDates) || !closedSessionDates.every(validDate) || !earlyClosesEt || typeof earlyClosesEt !== 'object' || Array.isArray(earlyClosesEt)) throw new TypeError('Forex calendar overrides must contain ISO closed-session dates and an early-close object');
  for (const [date, time] of Object.entries(earlyClosesEt)) if (!validDate(date) || !validLocalTime(time)) throw new TypeError(`Invalid Forex early-close override for ${date}`);
  if (instrument && !/^[A-Z]{3}_[A-Z]{3}$/.test(String(instrument).toUpperCase())) throw new TypeError('Forex session instrument must be a valid BASE_QUOTE pair.');
  const normalizedInstrument = String(instrument || '').toUpperCase();
  const symbols = normalizedInstrument.split('_');
  const isTryPair = symbols.includes('TRY');
  const hasNzdPair = symbols.includes('NZD');
  const timeZone = isTryPair ? TRY_TIME_ZONE : TIME_ZONE;
  const local = localParts(now, timeZone);
  const localDate = dateString(local);
  const minuteOfDay = local.hour * 60 + local.minute;
  let marketDate, closeTime, closeAt, isOpen;
  if (isTryPair) {
    marketDate = localDate;
    closeTime = '17:00';
    closeAt = localDateTimeToUtc(marketDate, 17, 0, timeZone);
    isOpen = local.weekday >= 1 && local.weekday <= 5 && minuteOfDay >= 8 * 60 && minuteOfDay < 17 * 60;
  } else {
    isOpen = local.weekday === 0 ? minuteOfDay >= 17 * 60 + 5
      : local.weekday === 6 ? false
        : local.weekday === 5 ? minuteOfDay < 16 * 60 + 59
          : minuteOfDay < 16 * 60 + 59 || minuteOfDay >= 17 * 60 + 5;
    marketDate = minuteOfDay >= 17 * 60 + 5 ? addCalendarDays(localDate, 1) : localDate;
    closeTime = earlyClosesEt[marketDate] ?? '16:59';
    const [closeHour, closeMinute] = closeTime.split(':').map(Number);
    closeAt = localDateTimeToUtc(marketDate, closeHour, closeMinute, timeZone);
  }
  const nzdLocal = hasNzdPair ? localParts(now, NZD_TIME_ZONE) : null;
  const nzdBreak = nzdLocal && nzdLocal.hour * 60 + nzdLocal.minute >= 6 * 60 + 59
    && nzdLocal.hour * 60 + nzdLocal.minute < 7 * 60 + 5;
  return {
    isOpen: isOpen && !nzdBreak && !closedSessionDates.includes(marketDate) && now < closeAt,
    timeZone, localDate, marketDate, closeAt, closeTimeEt: isTryPair ? null : closeTime,
    closeTimeLocal: closeTime, schedule: isTryPair ? 'try-central-europe-weekdays' : hasNzdPair ? 'fx-new-york-plus-nzd-break' : 'fx-new-york',
    nzdMaintenanceBreak: Boolean(nzdBreak),
  };
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validLocalTime(value) {
  if (typeof value !== 'string' || !/^(?:0\d|1[0-6]):[0-5]\d$/.test(value)) return false;
  return value < '16:59';
}
