/** Format a millisecond timestamp as the calendar date observed in a market timezone. */
export function marketDateAt(timestamp, timeZone) {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) throw new TypeError('Market date needs a finite timestamp.');
  if (typeof timeZone !== 'string' || !timeZone.trim()) throw new TypeError('Market date needs an explicit IANA timezone.');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${values.year}-${values.month}-${values.day}`;
}
