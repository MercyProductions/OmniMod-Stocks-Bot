const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Windows runs the combined Discord worker in this process; the detached
 * supervisor and its flock-backed shell script are Linux/cPanel-only. */
export function isWorkerOnlyMode(platform = process.platform, configured = process.env.OMNIMOD_WORKER_ONLY) {
  return platform === 'win32' || TRUTHY.has(String(configured || '').trim().toLowerCase());
}
