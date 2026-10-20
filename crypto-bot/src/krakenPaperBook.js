import { normalizeCryptoExecutionIdentity, cryptoIdentityRejection } from '../../new-bots/shared/cryptoExecutionIdentity.js';
import { normalizeCryptoQuoteEvidence, cryptoQuoteEvidenceRejection } from '../../new-bots/shared/cryptoQuoteEvidence.js';

const fail = code => { throw Object.assign(new Error(code), { code }); };

/** Bind a collector-verified native BBO to an already verified USD execution route. */
export function parseKrakenPaperBook(row, rawIdentity, { now = Date.now(), maxQuoteAgeMs = 15000 } = {}) {
  const identity = normalizeCryptoExecutionIdentity(rawIdentity);
  if (!identity || identity.provider !== 'Kraken' || cryptoIdentityRejection(identity, now)) return fail('kraken_book_identity_invalid');
  if (!Number.isFinite(now) || !Number.isFinite(maxQuoteAgeMs) || maxQuoteAgeMs <= 0) return fail('kraken_book_policy_invalid');
  if (!row) return fail('kraken_timestamped_bbo_unavailable');
  if (row?.symbol !== `${identity.base}/${identity.quoteCurrency}`) return fail('kraken_book_symbol_mismatch');
  const reason = cryptoQuoteEvidenceRejection(identity, row.cryptoQuoteEvidence, row);
  if (reason) return fail(reason);
  const evidence = normalizeCryptoQuoteEvidence(row.cryptoQuoteEvidence), age = now - Date.parse(evidence.time);
  if (age < -5000 || age > maxQuoteAgeMs) return fail('kraken_book_stale_or_future');
  return { provider: 'Kraken', pair: identity.pair, base: identity.base, target: identity.quoteCurrency,
    bid: evidence.bid, ask: evidence.ask, price: (evidence.bid + evidence.ask) / 2,
    observedAt: evidence.time, timestampBasis: 'provider_event', cryptoIdentity: identity, cryptoQuoteEvidence: evidence };
}
