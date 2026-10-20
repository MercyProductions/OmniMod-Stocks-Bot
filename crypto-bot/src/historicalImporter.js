import fs from 'node:fs/promises';
import path from 'node:path';
import { appendMicrostructureSamples } from './microstructure.js';
import { appendCandleBatch, appendResearchEvents } from './researchStore.js';
import { paths, readJson, writeJson } from './storage.js';

async function readNdjson(file) {
  const rows = [];
  for (const line of String(await fs.readFile(file, 'utf8')).split(/\r?\n/)) {
    if (!line) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

export async function importHistoricalResearch(directory) {
  const root = path.resolve(String(directory || ''));
  const stats = await fs.stat(root).catch(() => null);
  if (!stats?.isDirectory()) throw new Error('CRYPTO_HISTORICAL_IMPORT_DIR is not a readable directory.');
  const manifest = await readJson(paths.historicalImportManifest(), { version: 1, files: {} });
  const files = (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ndjson')).map((entry) => path.join(root, entry.name)).sort();
  const report = { filesRead: 0, filesSkipped: 0, rowsRead: 0, rowsImported: 0, rejected: 0, details: [] };
  for (const file of files) {
    const fileStats = await fs.stat(file);
    const signature = `${fileStats.size}:${fileStats.mtimeMs}`;
    if (manifest.files[file] === signature) { report.filesSkipped += 1; continue; }
    const rows = await readNdjson(file);
    report.filesRead += 1;
    report.rowsRead += rows.length;
    let imported = 0;
    const name = path.basename(file).toLowerCase();
    if (name.startsWith('micro-')) imported = await appendMicrostructureSamples(rows);
    else if (name.startsWith('observations-')) imported = await appendResearchEvents(rows);
    else if (name.startsWith('candles-')) {
      const groups = new Map();
      for (const row of rows) {
        const key = JSON.stringify([row.symbol || '', row.provider || 'licensed', row.pair || '']);
        groups.set(key, [...(groups.get(key) || []), row]);
      }
      for (const [key, candles] of groups) {
        const [symbol, provider, pair] = JSON.parse(key);
        imported += await appendCandleBatch(symbol, provider, candles, pair);
      }
    }
    report.rowsImported += imported;
    report.rejected += rows.length - imported;
    report.details.push({ file: path.basename(file), rows: rows.length, imported });
    manifest.files[file] = signature;
  }
  manifest.updatedAt = new Date().toISOString();
  await writeJson(paths.historicalImportManifest(), manifest);
  return report;
}
