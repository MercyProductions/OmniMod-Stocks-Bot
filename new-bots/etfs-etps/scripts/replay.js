import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayEtfOpeningRange } from '../src/replay.js';
import { replayPayload } from '../../shared/replayPayload.js';

export async function runEtfReplayFile(file) {
  if (!file) throw new Error('Pass a JSON replay dataset path or set ETF_REPLAY_FILE.');
  const path = resolve(file);
  const dataset = JSON.parse(await readFile(path, 'utf8'));
  const report = await replayPayload(dataset, replayEtfOpeningRange);
  return { dataset: path, report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runEtfReplayFile(process.argv[2] || process.env.ETF_REPLAY_FILE), null, 2)); }
  catch (error) { console.error(`ETF/ETP replay failed: ${String(error?.message || error).slice(0, 240)}`); process.exitCode = 1; }
}
