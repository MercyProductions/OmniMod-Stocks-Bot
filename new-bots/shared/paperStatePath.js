import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultLedgerPath = resolve(workspaceRoot, 'shared/data/shared-paper-risk.json');

/** Resolve the portfolio ledger independently of the launcher's working directory. */
export function resolvePaperLedgerPath(configured = '') {
  const value = String(configured ?? '').trim();
  if (!value) return defaultLedgerPath;
  return isAbsolute(value) ? resolve(value) : resolve(workspaceRoot, value);
}

export function getPaperLedgerWorkspaceRoot() {
  return workspaceRoot;
}

/** A non-reversible coordination key for comparing worker ledger paths in diagnostics. */
export function paperLedgerFingerprint(configured = '') {
  let ledgerPath = resolvePaperLedgerPath(configured);
  if (process.platform === 'win32') ledgerPath = ledgerPath.toLowerCase();
  return createHash('sha256').update(ledgerPath).digest('hex').slice(0, 16);
}
