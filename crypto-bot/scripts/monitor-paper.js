import { runCryptoPositionMonitor } from '../src/paperPositionMonitor.js';
try {
  const report = await runCryptoPositionMonitor();
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'degraded') process.exitCode = 2;
} catch {
  console.error('Crypto paper monitor failed; inspect configuration and ledger integrity. No successful pass is being claimed.');
  process.exitCode = 1;
}
