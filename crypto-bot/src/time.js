import { config } from './config.js';

export function localParts(date = new Date(), timezone = config.timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const values = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return Object.fromEntries(['year', 'month', 'day', 'hour', 'minute', 'second'].map((key) => [key, Number(values[key])]));
}

export function localDateKey(date = new Date(), timezone = config.timezone) {
  const p = localParts(date, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function localTimeLabel(date = new Date(), timezone = config.timezone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
  }).format(date);
}

export function isDailyDiscoveryTime(now = new Date(), settings = {}) {
  const p = localParts(now);
  return p.hour === Number(settings.dailyHour ?? config.dailyHour) && p.minute === Number(settings.dailyMinute ?? config.dailyMinute);
}
