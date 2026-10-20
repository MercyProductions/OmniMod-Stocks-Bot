import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const BOT_IDS = new Set(['stocks', 'crypto', 'forex', 'futures', 'options', 'etfs-etps']);

export function scanDiagnosticsFile(bot, directory = resolve(process.cwd(), 'data')) {
  if (!BOT_IDS.has(bot)) throw new Error('Unknown primary bot id.');
  return resolve(directory, `${bot}-scan-diagnostics.jsonl`);
}

export async function appendScanDiagnostic(bot, diagnostics, { directory, now = Date.now() } = {}) {
  const file = scanDiagnosticsFile(bot, directory);
  const row = { schemaVersion: 1, bot, capturedAt: new Date(now).toISOString(), diagnostics };
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(row)}\n`, { encoding: 'utf8', flag: 'a' });
  return { file, capturedAt: row.capturedAt };
}

export async function readScanDiagnosticRows(file, { limit = 500 } = {}) {
  let content;
  try { content = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rows = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row?.schemaVersion === 1 && BOT_IDS.has(row.bot) && row.diagnostics && typeof row.diagnostics === 'object'
        && Number.isFinite(Date.parse(row.capturedAt))) rows.push(row);
    } catch { /* Ignore torn or malformed trailing log rows; keep valid history. */ }
  }
  return rows.slice(-Math.max(1, Math.min(5000, Number(limit) || 500)));
}
