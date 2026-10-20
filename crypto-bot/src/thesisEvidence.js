export function cryptoEvidenceFactSource(fact = {}, marketSource = '') {
  if (fact.factSource) return String(fact.factSource).slice(0, 240);
  const key = String(fact.key || '');
  if (/^protocol_tvl/.test(key)) return 'DeFiLlama public protocol TVL history';
  if (/^protocol_(gross_revenue|earnings)|^token_holder_net_income/.test(key)) return 'DeFiLlama Pro protocol financial-statement endpoint';
  if (/^protocol_(active_users|transactions)_/.test(key)) return 'DeFiLlama Pro protocol activity endpoint';
  if (/^protocol_(max_supply|adjusted_supply|incentive_supply|non_incentive_supply)$/.test(key)) return 'DeFiLlama Pro emission endpoint';
  return String(marketSource || 'Market snapshot provider').slice(0, 240);
}
