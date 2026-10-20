import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const read = async (file) => {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
export const applicationStopPath = (directory) => join(directory, 'discord-stop-request.json');
export function matchesStopRequest(request, owner) {
  return Boolean(request && request.version === 1 && request.action === 'stop' && request.bot === owner.bot
    && request.pid === owner.pid && request.host === owner.host && request.ownerNonce === owner.nonce
    && typeof request.requestId === 'string' && /^[a-f0-9-]{36}$/i.test(request.requestId));
}

/** Local control only; a request addresses one exact lock owner, never a replacement. */
export function watchApplicationStop({ directory, owner, onStop, onError = () => {}, intervalMs = 1000 }) {
  let timer, active = false, closed = false;
  const poll = async () => {
    if (active || closed) return;
    active = true;
    try {
      const file = applicationStopPath(directory);
      const request = await read(file);
      if (!matchesStopRequest(request, owner)) return;
      // Remove only the request we consumed, before invoking lifecycle cleanup.
      if ((await read(file))?.requestId === request.requestId) await unlink(file);
      closed = true; clearInterval(timer);
      await onStop();
    } catch (error) { onError(error); }
    finally { active = false; }
  };
  return {
    start() { if (!timer && !closed) { timer = setInterval(() => void poll(), intervalMs); timer.unref?.(); } },
    close() { closed = true; clearInterval(timer); timer = null; },
    poll,
  };
}

export async function requestApplicationStop({ directory, bot, timeoutMs = 30000, pollMs = 100 }) {
  const lock = join(directory, 'discord-application.lock');
  const owner = await read(lock);
  if (!owner) return { status: 'no_recorded_owner', bot };
  if (owner.bot !== bot || owner.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0
    || typeof owner.nonce !== 'string' || !/^[a-f0-9-]{36}$/i.test(owner.nonce)) {
    throw new Error('Local application owner could not be verified; no stop request was written.');
  }
  const request = { version: 1, action: 'stop', bot, pid: owner.pid, host: owner.host,
    ownerNonce: owner.nonce, requestId: randomUUID(), requestedAt: new Date().toISOString() };
  const file = applicationStopPath(directory), temporary = `${file}.${request.requestId}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, JSON.stringify(request) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const current = await read(lock);
    if (!current) return { status: 'owner_released', bot, pid: owner.pid };
    if (current.nonce !== owner.nonce) return { status: 'owner_replaced', bot, pid: owner.pid };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { status: 'stop_not_confirmed', bot, pid: owner.pid };
}
