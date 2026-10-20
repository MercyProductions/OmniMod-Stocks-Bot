import { inspectPaperRiskLock } from './paperRisk.js';
import { resolvePaperLedgerPath } from './paperStatePath.js';

const statePath = resolvePaperLedgerPath(process.argv[2] || process.env.TRADING_RISK_STATE_PATH || '');
const result = await inspectPaperRiskLock({ statePath });
console.log(JSON.stringify(result, null, 2));
if (result.exists && result.ownerProcess === 'absent') process.exitCode = 2;
