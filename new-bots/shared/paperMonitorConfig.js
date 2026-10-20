export const POSITION_QUOTE_ADAPTER_VERSION = 'owned-position-quotes-v2-iso-reviewed-session';
export const STOCK_POSITION_QUOTE_ADAPTER_VERSION = 'stock-owned-quotes-v2-native-evidence';
export const CRYPTO_POSITION_QUOTE_ADAPTER_VERSION = 'crypto-owned-quotes-v2-native-book-evidence';
export const ETF_POSITION_QUOTE_ADAPTER_VERSION = 'etp-owned-quotes-v3-native-evidence';

export function paperMonitorProfile(env = process.env, owner) {
  const seconds = Number(env.PAPER_MONITOR_INTERVAL_SECONDS ?? 0);
  if (!Number.isInteger(seconds) || (seconds !== 0 && (seconds < 60 || seconds > 900))) {
    throw new TypeError('PAPER_MONITOR_INTERVAL_SECONDS must be 0 or an integer from 60 to 900.');
  }
  return { version: owner === 'etfs-etps' ? ETF_POSITION_QUOTE_ADAPTER_VERSION : owner === 'crypto' ? CRYPTO_POSITION_QUOTE_ADAPTER_VERSION : owner === 'stocks' ? STOCK_POSITION_QUOTE_ADAPTER_VERSION : POSITION_QUOTE_ADAPTER_VERSION,
    intervalSeconds: seconds, enabled: seconds > 0 };
}
