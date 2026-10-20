import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendScanDiagnostic } from '../scanDiagnosticsJournal.js';
import { collectOperatorReport } from '../operatorReport.js';

test('operator report preserves Forex decision refresh ages and local request deferrals', async () => {
  const root=await mkdtemp(join(tmpdir(),'omnimod-forex-refresh-operator-'));
  try {
    const now=Date.parse('2026-10-06T15:00:00Z');
    const decisionQuotes={production:{observations:2,reused:0,refreshed:1,failed:1,
      rows:[{instrument:'EUR_USD',beforeAgeMs:{EUR_USD:150_000},afterAgeMs:{EUR_USD:0}}]},shadow:{observations:1,reused:1}};
    const provider={requests:3,failures:0,localDeferrals:1};
    await appendScanDiagnostic('forex',{decisionQuotes,provider},{directory:join(root,'forex','data'),now});
    const report=await collectOperatorReport({rootDir:root,stocksDataDir:join(root,'stocks'),cryptoDataDir:join(root,'crypto'),
      ledgerPath:join(root,'missing.json'),now});
    assert.deepEqual(report.bots.forex.decisionQuotes,decisionQuotes);
    assert.deepEqual(report.bots.forex.provider,provider);
  } finally {assert.ok(resolve(root).startsWith(resolve(tmpdir())+'\\'));await rm(root,{recursive:true,force:true});}
});
