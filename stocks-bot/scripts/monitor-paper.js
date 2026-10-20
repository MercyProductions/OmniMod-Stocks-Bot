import { runStockPositionMonitor } from '../src/paperPositionMonitor.js';

try {
  const report = await runStockPositionMonitor();
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'degraded') process.exitCode = 2;
} catch {
  console.error('Stocks paper monitor failed; inspect configuration and ledger integrity. No successful pass is being claimed.');
  process.exitCode = 1;
}
