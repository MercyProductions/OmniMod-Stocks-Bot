/** Accept an amount only when an operator or persisted row supplied a finite number. */
export function hasExplicitFiniteAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string' || value.trim() === '') return false;
  const numeric = Number(value);
  return Number.isFinite(numeric);
}

/** Accept a cost amount only when an operator explicitly supplied a finite non-negative number. */
export function hasExplicitNonNegativeFiniteAmount(value) {
  return hasExplicitFiniteAmount(value) && Number(value) >= 0;
}

/** Accept a positive amount only when an operator or persisted row supplied a finite numeric value. */
export function hasExplicitPositiveFiniteAmount(value) {
  return hasExplicitFiniteAmount(value) && Number(value) > 0;
}
