import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayFuturesOpeningRange } from '../src/replay.js';
import { replayPayload } from '../../shared/replayPayload.js';

export async function runFuturesReplayFile(file) {
  if (!file) throw new Error('Pass a JSON replay dataset path or set FUTURES_REPLAY_FILE.');
  const path = resolve(file);
  const input = JSON.parse(await readFile(path, 'utf8'));
  const report = await replayPayload(input, replayFuturesOpeningRange);
  return { dataset: path, report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runFuturesReplayFile(process.argv[2] || process.env.FUTURES_REPLAY_FILE);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Futures replay failed: ${String(error?.message || error).slice(0, 240)}`);
    process.exitCode = 1;
  }
}
