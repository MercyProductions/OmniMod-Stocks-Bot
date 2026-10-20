/** Render an observed count without turning missing or malformed telemetry into zero. */
export function formatDiagnosticCount(value) {
  if (value === null || value === undefined || value === '') return 'unknown';
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count.toLocaleString('en-US') : 'unknown';
}
