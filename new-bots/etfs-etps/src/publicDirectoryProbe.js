import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { inspectNasdaqEtfDirectory, NASDAQ_ETF_DIRECTORY_URLS, ETF_DIRECTORY_INSPECTION_VERSION } from '../../shared/nasdaqEtfDirectory.js';

const MAX_BYTES = 10 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');

async function boundedText(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_BYTES) throw new Error('directory_body_too_large');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('directory_body_too_large');
    return text;
  }
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error('directory_body_too_large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

/** Two public directory GETs only. No credentials, quotes, accounts, paper state or Discord. */
export async function probePublicEtfDirectory({ fetcher = fetch, now = Date.now(), clock = performance.now.bind(performance) } = {}) {
  if (!Number.isFinite(now)) throw new TypeError('Probe time must be finite.');
  const started = clock();
  const sources = await Promise.all(Object.entries(NASDAQ_ETF_DIRECTORY_URLS).map(async ([kind, url]) => {
    const start = clock(); let text = null, status = null;
    try {
      const response = await fetcher(url, { headers: { accept: 'text/plain' }, signal: AbortSignal.timeout(20_000) });
      status = response.status;
      if (!response.ok) return { kind, url, status: 'http_error', httpStatus: status, latencyMs: Math.max(0, clock() - start) };
      text = await boundedText(response);
      const inspection = inspectNasdaqEtfDirectory(text, kind);
      return { kind, url, status: 'parsed', httpStatus: status, latencyMs: Math.max(0, clock() - start),
        text, bytes: Buffer.byteLength(text), sha256: digest(text), inspection };
    } catch (error) {
      const known = error?.message === 'directory_body_too_large' ? 'directory_body_too_large' : text === null ? 'transport_or_body_failure' : 'directory_schema_failure';
      return { kind, url, status: known, httpStatus: status, latencyMs: Math.max(0, clock() - start),
        ...(text !== null ? { text, bytes: Buffer.byteLength(text), sha256: digest(text) } : {}) };
    }
  }));
  const parsed = sources.filter(source => source.inspection), rows = parsed.flatMap(source => source.inspection.rows);
  const entries = new Map(), ambiguous = new Set();
  for (const source of parsed) for (const entry of source.inspection.entries) {
    if (entries.has(entry.symbol)) ambiguous.add(entry.symbol);
    else entries.set(entry.symbol, entry);
  }
  for (const symbol of ambiguous) entries.delete(symbol);
  const complete = parsed.length === 2 && !ambiguous.size && parsed.every(source => source.inspection.diagnostics.providerRows > 0 && source.inspection.diagnostics.footerComplete
    && !source.inspection.diagnostics.conflictingSymbols.length
    && !['malformed_row_width', 'invalid_classification_flag', 'missing_security_name'].some(reason => source.inspection.diagnostics.reasons[reason]));
  const reasons = {};
  for (const row of rows) if (row.reason) reasons[row.reason] = (reasons[row.reason] || 0) + 1;
  if (ambiguous.size) reasons.ambiguous_cross_file_symbol = ambiguous.size;
  const sourceDates = [...new Set(parsed.map(source => source.inspection.creationTime?.local?.slice(0, 10)).filter(Boolean))];
  const report = { version: ETF_DIRECTORY_INSPECTION_VERSION, capturedAt: new Date(now).toISOString(),
    status: complete ? 'directory_observed' : 'directory_incomplete', providerRequests: sources.length,
    providerFailures: sources.filter(source => source.status !== 'parsed').length, parsedFiles: parsed.length,
    fileEnumeration: complete ? 'both_complete_files_received' : 'incomplete_or_ambiguous',
    sourceDateAlignment: sourceDates.length === 1 && parsed.length === 2 ? 'same_reported_date' : 'mixed_or_missing_dates',
    sourceAgeMs: null, observedProviderRows: rows.length,
    totalProviderRows: complete ? rows.length : null,
    observedUniqueSymbols: new Set(rows.map(row => row.symbol).filter(Boolean)).size,
    observedEtfFlaggedRows: rows.filter(row => row.etfFlag === 'Y').length,
    observedAdapterEligibleEtfs: entries.size, completeAdapterUniverse: complete ? entries.size : null,
    rejectionReasons: reasons, ambiguousCrossFileSymbols: [...ambiguous].sort(),
    sources: sources.map(({ text, inspection, ...source }) => ({ ...source, creationTime: inspection?.creationTime || null,
      diagnostics: inspection?.diagnostics || null })),
    elapsedMs: Math.max(0, clock() - started), activeInstruments: null, accountTradable: null,
    priceScreened: 0, deepAnalyses: 0, strategyCandidates: 0, paperOrders: 0, discordPosts: 0, liveTrading: false,
    coverageBoundary: 'Nasdaq Trader ETF flags only. Non-ETF-flagged ETNs/ETVs, broker eligibility, listing changes after file generation, quotes and strategy suitability are unverified. Existing IEX/unknown-exchange and symbol-format exclusions are visible; no extra trading eligibility is granted.' };
  return { report, entries: [...entries.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)), sources };
}

/** Preserve source text, every row disposition and summary together; no production cache mutation. */
export async function savePublicEtfDirectoryProbe(result, directory) {
  const folder = resolve(directory), raw = JSON.stringify({ schemaVersion: 1, ...result });
  const hash = digest(raw), compressed = gzipSync(raw);
  const file = `${result.report.capturedAt.slice(0, 10)}-${hash}.json.gz`;
  await mkdir(folder, { recursive: true });
  try { await writeFile(join(folder, file), compressed, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error;
    if (digest(await readFile(join(folder, file))) !== digest(compressed)) throw new Error('Existing probe artifact does not match its content hash.'); }
  return { file, uncompressedSha256: hash, compressedSha256: digest(compressed), format: 'gzip-json-with-source-text-and-row-dispositions' };
}
