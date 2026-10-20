import { normalizeCryptoExecutionIdentity, CRYPTO_IDENTITY_MAX_AGE_MS } from '../../new-bots/shared/cryptoExecutionIdentity.js';
import { normalizeCryptoQuoteEvidence } from '../../new-bots/shared/cryptoQuoteEvidence.js';
import { hasExplicitPositiveFiniteAmount } from '../../new-bots/shared/strategyConfig.js';

function fail(code) { const error = new Error(code); error.code = code; throw error; }

export function parseCoinbasePaperBook(payload, rawIdentity, { now = Date.now(), maxQuoteAgeMs = 15000 } = {}) {
  const identity = normalizeCryptoExecutionIdentity(rawIdentity);
  if (!identity || identity.provider !== 'Coinbase') fail('coinbase_book_identity_invalid');
  const identityAge = now - Date.parse(identity.verifiedAt);
  if (!Number.isFinite(now) || !Number.isFinite(maxQuoteAgeMs) || maxQuoteAgeMs <= 0
    || identityAge < -5000 || identityAge > CRYPTO_IDENTITY_MAX_AGE_MS) fail('coinbase_book_policy_or_identity_stale');
  // Coinbase omits auction fields for some normal books. Any present auction
  // evidence is conservatively rejected; indicative prices cannot model fills.
  if ((payload?.auction_mode != null && payload.auction_mode !== false)
    || payload?.auction != null) fail('coinbase_book_auction_or_unknown_mode');
  if (!Array.isArray(payload?.bids) || payload.bids.length !== 1
    || !Array.isArray(payload?.asks) || payload.asks.length !== 1
    || ![payload.bids[0], payload.asks[0]].every(row => Array.isArray(row) && row.length >= 2
      && row.slice(0, 2).every(hasExplicitPositiveFiniteAmount))) fail('coinbase_book_invalid_levels');
  const age = now - Date.parse(typeof payload.time === 'string' ? payload.time : '');
  if (!Number.isFinite(age) || age < -5000 || age > maxQuoteAgeMs) fail('coinbase_book_stale_or_missing_time');
  const evidence = normalizeCryptoQuoteEvidence({ version: 1, kind: 'coinbase_l1_book', pair: identity.pair,
    sequence: payload.sequence, time: payload.time, auctionMode: false,
    bid: Number(payload.bids[0][0]), ask: Number(payload.asks[0][0]),
    bidSize: Number(payload.bids[0][1]), askSize: Number(payload.asks[0][1]) });
  if (!evidence) fail('coinbase_book_invalid_evidence');
  return { provider: 'Coinbase', pair: identity.pair, base: identity.base, target: identity.quoteCurrency,
    bid: evidence.bid, ask: evidence.ask, price: (evidence.bid + evidence.ask) / 2,
    observedAt: evidence.time, timestampBasis: 'provider_order_book',
    cryptoIdentity: identity, cryptoQuoteEvidence: evidence };
}
