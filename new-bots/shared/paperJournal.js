import { appendFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// Append-only point-in-time research snapshots. This records observations, not
// fills, holdings, or realized profit; grading needs later outcome data.
export async function appendPaperSnapshot(bot, observations, metadata = {}) {
  const capturedAt = new Date().toISOString();
  const file = resolve(process.cwd(), 'data', `${bot}.jsonl`);
  await mkdir(resolve(process.cwd(), 'data'), { recursive: true });
  const lines = observations.map((observation) => {
    const source = { bot, capturedAt, metadata, observation };
    const id = createHash('sha256').update(JSON.stringify(source)).digest('hex');
    return JSON.stringify({ id, ...source });
  });
  if (lines.length) await appendFile(file, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'a' });
  return { file: 'data/' + file.split(/[\\/]/).at(-1), rowsWritten: lines.length, capturedAt };
}
