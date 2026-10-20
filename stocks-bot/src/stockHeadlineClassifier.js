const STOCK_HEADLINE_RULES = Object.freeze([
  { eventType: 'dilution_or_offering', pattern: /\b(secondary offering|public offering|registered direct offering|share dilution|dilutive financing|at-the-market offering)\b/i, potentialSeverity: 'high' },
  { eventType: 'fda_decision', pattern: /\b(FDA (?:approves?|clears?|rejects?|declines?|halts?|issues?))\b/i, potentialSeverity: 'high' },
  { eventType: 'guidance_change', pattern: /\b(raises?|cuts?|lowers?|withdraws?) (?:its )?(?:full-year |quarterly |financial )?(?:guidance|outlook|forecast)\b/i, potentialSeverity: 'high' },
  { eventType: 'earnings', pattern: /\b(earnings|quarterly results|reports? (?:Q[1-4]|first|second|third|fourth) quarter)\b/i, potentialSeverity: 'medium' },
  { eventType: 'merger_or_acquisition', pattern: /\b(merger|acquisition|acquires?|to acquire|buyout|takeover)\b/i, potentialSeverity: 'high' },
  { eventType: 'lawsuit_or_regulatory', pattern: /\b(lawsuit|sued|subpoena|SEC investigation|regulatory probe|antitrust probe|settlement with regulators)\b/i, potentialSeverity: 'high' },
  { eventType: 'analyst_rating_change', pattern: /\b(upgrades? to|downgrades? to|initiates? coverage|raises? price target|cuts? price target)\b/i, potentialSeverity: 'medium' },
  { eventType: 'share_repurchase', pattern: /\b(share repurchase|stock buyback|authorizes? .* buyback)\b/i, potentialSeverity: 'medium' },
  { eventType: 'executive_change', pattern: /\b(CEO|CFO|chief executive|chief financial officer).{0,35}\b(resigns?|steps down|departs?|appointed|named)\b/i, potentialSeverity: 'medium' },
  { eventType: 'contract_or_order', pattern: /\b(wins? .* contract|awarded .* contract|receives? .* order|signs? .* agreement)\b/i, potentialSeverity: 'medium' },
  { eventType: 'product_or_business_update', pattern: /\b(product launch|launches? .* product|recall|production halt|factory shutdown)\b/i, potentialSeverity: 'medium' },
]);

/** Advisory title tagging only; this is not verification, sentiment, or a trade signal. */
export function classifyStockHeadline(headline) {
  const text = String(headline || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500);
  const matches = STOCK_HEADLINE_RULES.filter((row) => row.pattern.test(text));
  const uncertain = /\b(rumou?r|unconfirmed|alleged|reportedly|may|might|could|denies?|without|no evidence|not confirmed)\b/i.test(text);
  if (matches.length !== 1 || uncertain) return {
    eventType: matches.length > 1 ? 'multiple_or_ambiguous' : matches.length ? matches[0].eventType : 'unknown',
    direction: 'unknown', expectedness: 'unknown', horizon: 'unknown', impact: 'unknown', potentialSeverity: 'unknown',
    classificationStatus: matches.length > 1 ? 'ambiguous' : uncertain && matches.length ? 'unverified_wording' : 'unclassified',
    classificationMethod: 'conservative_headline_rules_v1',
  };
  const { eventType, potentialSeverity } = matches[0];
  let direction = 'unknown';
  if (eventType === 'dilution_or_offering' || eventType === 'lawsuit_or_regulatory') direction = 'negative';
  else if (eventType === 'fda_decision') direction = /\b(approves?|clears?)\b/i.test(text) ? 'positive' : /\b(rejects?|declines?|halts?)\b/i.test(text) ? 'negative' : 'unknown';
  else if (eventType === 'guidance_change') direction = /\b(raises?|boosts?)\b/i.test(text) ? 'positive' : /\b(cuts?|lowers?|withdraws?)\b/i.test(text) ? 'negative' : 'unknown';
  else if (eventType === 'earnings') direction = /\b(beats?|tops?|exceeds?) estimates\b/i.test(text) ? 'positive' : /\b(misses?|falls? short of) estimates\b/i.test(text) ? 'negative' : 'unknown';
  else if (eventType === 'analyst_rating_change') direction = /\b(upgrades? to|raises? price target)\b/i.test(text) ? 'positive' : /\b(downgrades? to|cuts? price target)\b/i.test(text) ? 'negative' : 'unknown';
  else if (eventType === 'executive_change' && /\b(resigns?|steps down|departs?)\b/i.test(text)) direction = 'negative';
  return { eventType, direction, expectedness: 'unknown', horizon: 'unknown', impact: 'unknown', potentialSeverity,
    classificationStatus: 'topic_match_only', classificationMethod: 'conservative_headline_rules_v1' };
}

export function summarizeStockHeadlineClassification(items = []) {
  const rows = Array.isArray(items) ? items : [];
  const eventTypes = {};
  for (const row of rows) {
    const type = String(row?.eventType || 'unknown');
    eventTypes[type] = (eventTypes[type] || 0) + 1;
  }
  return { total: rows.length,
    topicMatched: rows.filter((row) => row?.classificationStatus === 'topic_match_only').length,
    ambiguous: rows.filter((row) => row?.classificationStatus === 'ambiguous').length,
    unverifiedWording: rows.filter((row) => row?.classificationStatus === 'unverified_wording').length,
    unclassified: rows.filter((row) => row?.classificationStatus === 'unclassified').length,
    explicitPolarityTags: rows.filter((row) => row?.classificationStatus === 'topic_match_only' && ['positive', 'negative'].includes(row?.direction)).length,
    eventTypes };
}
