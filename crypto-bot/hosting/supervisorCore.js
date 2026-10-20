import { join } from 'node:path';
import { matchesProcess, stopOwned } from './common.js';

/** Reconcile each market separately; one failed startup never stops its sibling. */
export function createSupervisor({ definitions, readStatus, inspect, launch, log, clock = Date.now, stop = stopOwned }) {
  const attempts = new Map();
  let active = null;
  async function reconcileOne(definition, paused) {
    const { market, entry, cwd, revision } = definition;
    const saved = await readStatus(market);
    const current = saved ? await inspect(saved.processId) : null;
    const owned = matchesProcess(saved, current, entry, cwd, market);
    if (current && !owned) {
      // A malformed or reused PID must never be signalled or declared safely stopped.
      return { market, state: 'identity_conflict', stopped: false };
    }
    if (owned) {
      if (paused || saved.deploymentId !== revision) {
        if (!await stop(saved, entry, cwd, market, { inspect })) throw new Error('Worker ownership changed during stop');
        attempts.delete(market);
        return { market, state: paused ? 'paused' : 'replacing', stopped: true };
      }
      const age = clock() - Date.parse(saved.heartbeatAt);
      if (age > 45000 || age < -5000 || !Number.isFinite(age)) return { market, state: 'stale_owner', stopped: false };
      if (saved.discordReady && clock() - Date.parse(saved.startedAt) > 60000) attempts.delete(market);
      return { market, state: saved.state, stopped: false };
    }
    if (paused) return { market, state: 'paused', stopped: true };
    const attempt = attempts.get(market) || { count: 0, nextAt: 0 };
    if (clock() < attempt.nextAt) return { market, state: 'restart_backoff', retryAt: new Date(attempt.nextAt).toISOString(), stopped: true };
    const count = Math.min(6, attempt.count + 1);
    attempts.set(market, { count, nextAt: clock() + Math.min(300000, 15000 * 2 ** (count - 1)) });
    await launch(definition);
    log('worker_launch_requested', market);
    return { market, state: 'starting', stopped: false };
  }
  return {
    reconcile(pausedMarkets = []) {
      if (active) return active;
      active = Promise.all(definitions.map(async (definition) => {
        try { return await reconcileOne(definition, pausedMarkets.includes(definition.market)); }
        catch (error) { log('worker_reconcile_failed', definition.market, error.message); return { market: definition.market, state: 'error', stopped: false }; }
      })).finally(() => { active = null; });
      return active;
    }
  };
}

export function launchSpecification(definition, { node, stateDirectory, env }) {
  return { command: '/usr/bin/flock', args: ['-n', join(stateDirectory, `${definition.market}.lock`), node, definition.entry, definition.market],
    options: { cwd: definition.cwd, detached: true, stdio: 'ignore', env } };
}
