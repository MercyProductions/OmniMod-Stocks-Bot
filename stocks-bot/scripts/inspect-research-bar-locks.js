import { dataDir } from '../src/config.js';
import path from 'node:path';
import { inspectResearchBarLocks } from '../src/researchBarLockDiagnostics.js';

const report = await inspectResearchBarLocks({
  barDirectory: path.join(dataDir, 'research', 'bars'),
  additionalDirectories: [path.join(dataDir, 'research', 'checkpoints')],
});
console.log(JSON.stringify(report, null, 2));
