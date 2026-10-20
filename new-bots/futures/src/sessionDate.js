import { marketDateAt } from '../../shared/marketDate.js';

/** Return the exchange-local calendar date used for Futures session accounting. */
export function futuresMarketDateAt(timestamp) {
  return marketDateAt(timestamp, 'America/Chicago');
}
