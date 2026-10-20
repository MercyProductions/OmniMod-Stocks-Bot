import { screenEquitySnapshot, screenFullEquityMarket, archiveDiscovery } from '../../shared/equitySnapshotDiscovery.js';

export const ETF_DISCOVERY_VERSION = 'etf-full-directory-v2-audited-listings';
export const screenEtfSnapshot = screenEquitySnapshot;
export const archiveEtfDiscovery = archiveDiscovery;
export const screenFullEtfMarket = (options) => screenFullEquityMarket({ ...options, version: ETF_DISCOVERY_VERSION });
