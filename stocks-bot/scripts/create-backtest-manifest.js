import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assessBacktestManifest, backtestDatasetSha256 } from '../src/backtestManifest.js';

const args = Object.fromEntries(process.argv.slice(2).map((item) => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
const required = ['data', 'out', 'provider', 'datasetId', 'retrievedAt', 'timezone', 'timestampSemantics', 'universeCoverage', 'corporateActions', 'licenseStatus', 'licenseReference'];
const missing = required.filter((key) => !args[key]?.trim());
if (missing.length) throw new Error(`Missing required options: ${missing.map((key) => `--${key}`).join(', ')}`);

const inputPath = resolve(args.data);
const outputPath = resolve(args.out);
if (inputPath === outputPath) throw new Error('Refusing to overwrite the source dataset; choose a separate --out path.');
const source = JSON.parse(await readFile(inputPath, 'utf8'));
if (!source || typeof source !== 'object' || Array.isArray(source) || !source.symbols || typeof source.symbols !== 'object' || Array.isArray(source.symbols)) {
  throw new TypeError('Input must be a Stock backtest dataset with a symbols object.');
}
const dataset = { ...source };
delete dataset.manifest;
const manifest = {
  schemaVersion: 1,
  provider: args.provider.trim(),
  datasetId: args.datasetId.trim(),
  retrievedAt: args.retrievedAt.trim(),
  timezone: args.timezone.trim(),
  timestampSemantics: args.timestampSemantics.trim(),
  universeCoverage: args.universeCoverage.trim(),
  corporateActions: args.corporateActions.trim(),
  licenseStatus: args.licenseStatus.trim(),
  licenseReference: args.licenseReference.trim(),
  contentSha256: backtestDatasetSha256(dataset),
};
assessBacktestManifest(manifest, dataset);
await writeFile(outputPath, `${JSON.stringify({ ...dataset, manifest }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
console.log(`Created ${outputPath}`);
console.log(`Dataset SHA-256: ${manifest.contentSha256}`);
console.log('Manifest fields are operator declarations, not independent provider, license, or timestamp verification.');
