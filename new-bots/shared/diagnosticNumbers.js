/** Preserve an unmeasured diagnostic as unknown instead of coercing it to zero. */
export function observedNonNegativeNumber(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
