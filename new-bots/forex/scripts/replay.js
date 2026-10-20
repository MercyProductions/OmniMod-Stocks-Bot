import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayForexDayBreakout } from '../src/replay.js';
import { replayPayload } from '../../shared/replayPayload.js';

export async function runForexReplayFile(file) {
  if (!file) throw new Error('Pass a JSON replay dataset path or set FOREX_REPLAY_FILE.');
  const path = resolve(file);
  const report = await replayPayload(JSON.parse(await readFile(path, 'utf8')), replayForexDayBreakout);
  return { dataset: path, report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runForexReplayFile(process.argv[2] || process.env.FOREX_REPLAY_FILE), null, 2)); }
  catch (error) { console.error(`Forex replay failed: ${String(error?.message || error).slice(0, 240)}`); process.exitCode = 1; }
}
