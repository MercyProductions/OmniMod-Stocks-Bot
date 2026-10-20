// Node 20-compatible hosting support. No strategy/provider imports in this module.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, readdir, readlink, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';

export const hostingDir = dirname(fileURLToPath(import.meta.url));
export const appDir = dirname(hostingDir);
export const markets = ['crypto', 'stocks'];
export const stateDir = process.env.OMNIMOD_INDEPENDENT_STATE_DIR || join(homedir(), '.omnimod-independent-host');
export const legacyStatusFile = process.env.OMNIMOD_MARKET_STATUS_FILE || join(homedir(), '.omnimod-market-worker-status.json');
export const botDir = (market) => { if (!markets.includes(market)) throw new Error('Unknown market'); return join(dirname(appDir), `${market}-bot`); };
export const statusPath = (market) => join(stateDir, `${market}.json`);
export const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

export async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}
export function redact(value, env = process.env) {
  let text = String(value);
  for (const [key, secret] of Object.entries(env)) {
    if (/(TOKEN|SECRET|PASSWORD|API_KEY|WEBHOOK)/i.test(key) && secret?.length >= 6) text = text.split(secret).join('[REDACTED]');
  }
  return text.replace(/(?:Bot|Bearer)\s+[^\s,;]+/gi, '[REDACTED AUTH]')
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g, '[REDACTED TOKEN]')
    .replace(/https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s]+/gi, '[REDACTED WEBHOOK]');
}
export function createLog(name, directory = stateDir, env = process.env) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${name}.log`);
  return (event, ...args) => {
    const line = JSON.stringify({ at: new Date().toISOString(), name, event, detail: redact(format(...args), env).slice(0, 8192) }) + '\n';
    try {
      if ((statSync(file, { throwIfNoEntry: false })?.size || 0) > 2 * 1024 * 1024) {
        try { unlinkSync(`${file}.previous`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        renameSync(file, `${file}.previous`);
      }
      appendFileSync(file, line, { mode: 0o600 });
    } catch { process.stderr.write(`${name}: hosting log unavailable\n`); }
  };
}
// A saved PID alone is never sufficient permission to signal an existing process.
export async function processIdentity(pid, procRoot = '/proc') {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const [stat, command, cwd] = await Promise.all([
      readFile(join(procRoot, String(pid), 'stat'), 'utf8'),
      readFile(join(procRoot, String(pid), 'cmdline'), 'utf8'),
      readlink(join(procRoot, String(pid), 'cwd'))
    ]);
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return null;
    return { pid, startTicks: fields[19], cwd, args: command.split('\0').filter(Boolean) };
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
}
export function matchesProcess(saved, current, entry, cwd, argument) {
  return Boolean(saved && current && saved.processId === current.pid && saved.startTicks === current.startTicks
    && resolve(current.cwd) === resolve(cwd) && current.args.length === (argument ? 3 : 2)
    && resolve(current.cwd, current.args[1]) === resolve(entry) && (!argument || current.args[2] === argument));
}
export async function stopOwned(saved, entry, cwd, argument, { inspect = processIdentity, kill = process.kill, sleep = delay, attempts = 40 } = {}) {
  const current = await inspect(saved?.processId);
  if (!matchesProcess(saved, current, entry, cwd, argument)) return !current;
  kill(current.pid, 'SIGTERM');
  for (let i = 0; i < attempts; i++) {
    await sleep(250);
    if (!matchesProcess(saved, await inspect(current.pid), entry, cwd, argument)) return true;
  }
  // Never start a replacement beside an unconfirmed old owner, or kill an unrelated PID.
  throw new Error('Owned worker did not exit after SIGTERM; replacement withheld');
}
export async function revisionFor(market) {
  const hash = createHash('sha256');
  async function visit(directory) {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, item.name);
      if (item.isDirectory()) await visit(file);
      else if (item.name !== 'control.json' && /\.(?:js|cjs|mjs|json)$/.test(item.name)) hash.update(file).update(await readFile(file));
    }
  }
  await visit(hostingDir);
  if (market) {
    await visit(join(botDir(market), 'src'));
    hash.update(await readFile(join(botDir(market), 'package.json')));
  }
  return hash.digest('hex').slice(0, 16);
}
export function publicWorker(saved, now = Date.now()) {
  if (!saved) return { state: 'starting', discordReady: false };
  const age = now - Date.parse(saved.heartbeatAt);
  const fresh = Number.isFinite(age) && age >= -5000 && age <= 45000;
  return { market: saved.market, processId: saved.processId, state: fresh ? saved.state : 'stale',
    phase: saved.phase, discordReady: fresh && saved.discordReady === true,
    discordUser: saved.discordUser, clientId: saved.clientId, heartbeatAt: saved.heartbeatAt,
    startedAt: saved.startedAt, deploymentId: saved.deploymentId, nodeVersion: saved.nodeVersion,
    lastScanAt: saved.lastScanAt, scansCompleted: saved.scansCompleted,
    schedulerRunning: saved.schedulerRunning ?? null, lastTickAt: saved.lastTickAt,
    nextTickAt: saved.nextTickAt, configuredGuilds: saved.configuredGuilds,
    lastError: redact(saved.lastError || '').slice(0, 500) };
}
export function isolatedEnvironment(market, env) {
  const result = { ...env, OMNIMOD_EMBEDDED_HOST: '1' };
  if (market === 'stocks') {
    for (const suffix of ['TOKEN', 'CLIENT_ID', 'GUILD_ID']) {
      // Prevent missing Stocks configuration from falling back to Crypto's identity.
      delete result[`DISCORD_${suffix}`];
      if (env[`STOCKS_DISCORD_${suffix}`]) result[`DISCORD_${suffix}`] = env[`STOCKS_DISCORD_${suffix}`];
    }
  } else {
    for (const key of Object.keys(result)) if (key.startsWith('STOCKS_DISCORD_')) delete result[key];
  }
  return result;
}
