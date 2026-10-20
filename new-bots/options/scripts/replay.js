import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayOptionDebitVertical } from '../src/replay.js';
import { replayPayload } from '../../shared/replayPayload.js';

export async function runOptionsReplayFile(file) {
  if (!file) throw new Error('Pass a JSON replay dataset path or set OPTIONS_REPLAY_FILE.');
  const path = resolve(file);
  const report = await replayPayload(JSON.parse(await readFile(path, 'utf8')), replayOptionDebitVertical);
  return { dataset: path, report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runOptionsReplayFile(process.argv[2] || process.env.OPTIONS_REPLAY_FILE), null, 2)); }
  catch (error) { console.error(`Options replay failed: ${String(error?.message || error).slice(0, 240)}`); process.exitCode = 1; }
}
