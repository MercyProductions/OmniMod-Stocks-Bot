import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPaperRiskLock, recoverPaperOrders } from './paperRisk.js';
import { resolvePaperLedgerPath } from './paperStatePath.js';

/** Run operator-triggered paper recovery without bypassing an existing ledger lock. */
export async function runPaperRecovery({
  statePath = resolvePaperLedgerPath(process.env.TRADING_RISK_STATE_PATH || ''),
  now = Date.now(), emergencyStop = process.env.OMNIMOD_EMERGENCY_STOP !== 'false', ownerStoppedConfirmed = false,
} = {}) {
  const resolvedStatePath = resolvePaperLedgerPath(statePath);
  const lock = await inspectPaperRiskLock({ statePath: resolvedStatePath, now });
  if (lock.exists) return { status: 'blocked', reason: 'ledger_lock_requires_manual_review', lock };
  if (ownerStoppedConfirmed !== true) return { status: 'blocked', reason: 'operator_confirmation_required', lock };
  const recovery = await recoverPaperOrders({ statePath: resolvedStatePath, now, emergencyStop });
  return { status: 'reconciled', lock, recovery };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const ownerStoppedConfirmed = args.includes('--confirm-owner-stopped');
    const statePath = args.find((arg) => arg !== '--confirm-owner-stopped');
    const result = await runPaperRecovery({ statePath, ownerStoppedConfirmed });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'blocked') process.exitCode = 2;
  } catch (error) {
    console.error(`Paper recovery failed closed: ${error.message}`);
    process.exitCode = 1;
  }
}
