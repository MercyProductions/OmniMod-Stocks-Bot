// Decimal integer arithmetic keeps quantity floors on the exchange's grid.
// Runtime prices/P&L remain Numbers; reject quantities that cannot round-trip.
function decimal(value) {
  if (!['string', 'number'].includes(typeof value) || String(value).length > 80
    || !Number.isFinite(Number(value)) || Number(value) < 0) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match || Math.abs(Number(match[3] || 0)) > 40) return null;
  let scale = (match[2] || '').length - Number(match[3] || 0);
  let coefficient = BigInt(match[1] + (match[2] || ''));
  if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
  if (scale > 40) return null;
  return { coefficient, scale };
}
const power = n => 10n ** BigInt(n);
const asString = ({ coefficient, scale }) => {
  if (!scale) return String(coefficient);
  const digits = String(coefficient).padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/0+$/, '').replace(/\.$/, '');
};
export function normalizePositiveDecimal(value) {
  const parsed = decimal(value);
  return parsed?.coefficient > 0n ? asString(parsed) : null;
}
export function isIncrementMultiple(value, increment) {
  const v = decimal(value), step = decimal(increment);
  return Boolean(v?.coefficient > 0n && step?.coefficient > 0n
    && (v.coefficient * power(step.scale)) % (step.coefficient * power(v.scale)) === 0n);
}
export function decimalProductAtLeast(a, b, minimum) {
  const x = decimal(a), y = decimal(b), min = decimal(minimum);
  return Boolean(x && y && min && x.coefficient * y.coefficient * power(min.scale)
    >= min.coefficient * power(x.scale + y.scale));
}
export function roundPriceIncrement(value, increment, direction = 'down') {
  const amount = decimal(value), step = decimal(increment);
  if (!(amount?.coefficient > 0n) || !(step?.coefficient > 0n) || !['up', 'down'].includes(direction)) return NaN;
  const numerator = amount.coefficient * power(step.scale), denominator = step.coefficient * power(amount.scale);
  const lots = numerator / denominator + (direction === 'up' && numerator % denominator ? 1n : 0n);
  const price = Number(asString({ coefficient: lots * step.coefficient, scale: step.scale }));
  return isIncrementMultiple(price, increment) ? price : NaN;
}
export function floorRiskQuantity(riskBudget, riskPerUnit, increment) {
  const budget = decimal(riskBudget), risk = decimal(riskPerUnit), step = decimal(increment);
  if (!budget || !(risk?.coefficient > 0n) || !(step?.coefficient > 0n)) return 0;
  let lots = budget.coefficient * power(risk.scale + step.scale)
    / (risk.coefficient * step.coefficient * power(budget.scale));
  // Number multiplication can round one ULP above the budget. Never round up
  // risk to force a trade; at most one additional lot is removed conservatively.
  for (let attempt = 0; attempt < 2 && lots > 0n; attempt++, lots--) {
    const units = Number(asString({ coefficient: lots * step.coefficient, scale: step.scale }));
    if (Number.isFinite(units) && isIncrementMultiple(units, increment)
      && units * Number(riskPerUnit) <= Number(riskBudget)) return units;
  }
  return 0;
}
