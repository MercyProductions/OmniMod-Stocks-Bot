import { createHash } from 'node:crypto';

const ENUMS = {
  timestampSemantics: ['bar_open', 'bar_close', 'unknown'],
  universeCoverage: ['historical_point_in_time', 'current_snapshot', 'unknown'],
  corporateActions: ['split_adjusted', 'unadjusted', 'unknown'],
  licenseStatus: ['authorized', 'restricted', 'unknown'],
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function backtestDatasetSha256(dataset) {
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) throw new TypeError('Backtest dataset must be an object.');
  const { manifest: _manifest, ...payload } = dataset;
  return createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
}

/** Validate declared dataset provenance without implying that declarations were independently audited. */
export function assessBacktestManifest(manifest, dataset) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.schemaVersion !== 1) {
    throw new TypeError('Local stock backtest data must include manifest.schemaVersion = 1.');
  }
  for (const field of ['provider', 'datasetId', 'retrievedAt', 'timezone', 'licenseReference']) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim()) {
      throw new TypeError(`Backtest manifest requires a non-empty ${field}.`);
    }
  }
  if (!/^[a-f0-9]{64}$/i.test(manifest.contentSha256 || '')) throw new TypeError('Backtest manifest requires a 64-character SHA-256 contentSha256.');
  if (!dataset || backtestDatasetSha256(dataset) !== manifest.contentSha256.toLowerCase()) {
    throw new TypeError('Backtest dataset SHA-256 does not match manifest.contentSha256.');
  }
  if (!Number.isFinite(Date.parse(manifest.retrievedAt))) throw new TypeError('Backtest manifest retrievedAt must be a timestamp.');
  for (const [field, allowed] of Object.entries(ENUMS)) {
    if (!allowed.includes(manifest[field])) throw new TypeError(`Backtest manifest ${field} must be one of: ${allowed.join(', ')}.`);
  }
  const eligible = manifest.timestampSemantics === 'bar_open'
    && manifest.universeCoverage === 'historical_point_in_time'
    && manifest.corporateActions === 'split_adjusted'
    && manifest.licenseStatus === 'authorized';
  return {
    provider: manifest.provider.trim(), datasetId: manifest.datasetId.trim(), retrievedAt: new Date(manifest.retrievedAt).toISOString(),
    timezone: manifest.timezone.trim(), timestampSemantics: manifest.timestampSemantics,
    universeCoverage: manifest.universeCoverage, corporateActions: manifest.corporateActions,
    licenseStatus: manifest.licenseStatus, licenseReference: manifest.licenseReference.trim(),
    contentSha256: manifest.contentSha256.toLowerCase(),
    metadataSupportsOosReview: eligible,
  };
}
