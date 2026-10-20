import { buildPrediction } from './predictionEngine.js';
import { selectSourcePinnedEntryQuote, RESEARCH_ENTRY_EVIDENCE_VERSION } from './researchStore.js';

export function buildSourcePinnedShadowPrediction(asset, settings, guildId, now = new Date(),
  timezone = 'America/Chicago', history = [], modelBundles = {}) {
  const quote = selectSourcePinnedEntryQuote(asset, now);
  if (!quote) return null;
  const prediction = buildPrediction({ ...asset, price: quote.ask }, settings, guildId, now,
    timezone, history, modelBundles);
  const sourceSpreadPct = (quote.ask - quote.bid) / quote.ask * 100;
  const reservePct = Math.max(0, Number(settings.estimatedRoundTripBps) || 0) / 100;
  return {
    quote, prediction, entryEvidenceVersion: RESEARCH_ENTRY_EVIDENCE_VERSION,
    estimatedCostPct: Math.max(prediction.estimatedCostPct, sourceSpreadPct + reservePct),
  };
}
