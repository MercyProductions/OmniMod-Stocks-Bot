import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { dataDir } from '../src/config.js';
import { researchFiles } from '../src/researchStore.js';
import { requestPredictiveForecast } from '../src/predictiveClient.js';

// One bounded pass. Schedule independently of Discord; neither API failure nor a
// missing Python process can delay the primary scanner. SQLite makes retries idempotent.
const endpoint = process.env.STOCKS_FORECAST_URL;
const token = process.env.STOCKS_FORECAST_TOKEN;
if (!endpoint || !token) throw new Error('Set STOCKS_FORECAST_URL and a dedicated STOCKS_FORECAST_TOKEN in the worker environment');
const stateFile = path.join(dataDir, 'predictive-worker-cursor.json');
await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
const lock = await fs.open(`${stateFile}.lock`, 'wx', 0o600);
try {
  let state;
  try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = {}; }
  let submitted = 0, deferred = false;
  const started = Date.now();
  outer: for (const file of await researchFiles('features')) {
    const position = state[file] || 0;
    if ((await fs.stat(file)).size < position) throw new Error('Research source truncated; cursor requires review');
    const stream = createReadStream(file, { start: position });
    let consumed = position;
    // Byte-framed complete lines keep the offset safe across UTF-8 text and torn appends.
    let pending = Buffer.alloc(0);
    try {
      for await (const chunk of stream) {
        pending = Buffer.concat([pending, chunk]);
        let end;
        while ((end = pending.indexOf(10)) >= 0) {
          const line = pending.subarray(0, end + 1);
          pending = pending.subarray(end + 1);
          if (line.length > 2_000_000) throw new Error('Oversized research record');
          const row = JSON.parse(line.toString('utf8'));
          if (row.predictiveObservation) {
            await requestPredictiveForecast(row.predictiveObservation, { endpoint, token });
            submitted++;
          }
          consumed += line.length;
          state[file] = consumed;
          if (submitted >= 250 || Date.now() - started > 45000) { deferred = true; break outer; }
        }
        if (pending.length > 2_000_000) throw new Error('Oversized incomplete research record');
      }
    } finally { stream.destroy(); }
  }
  console.log(JSON.stringify({ submitted, deferred, durationMs: Date.now() - started, productionOrders: 0, discordPosts: 0 }));
  await fs.writeFile(`${stateFile}.tmp`, JSON.stringify(state), { mode: 0o600 });
  await fs.rename(`${stateFile}.tmp`, stateFile);
} finally { await lock.close(); await fs.unlink(`${stateFile}.lock`); }
