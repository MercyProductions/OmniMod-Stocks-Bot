import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { summarizeFuturesFunnel } from '../src/diagnostics.js';
import { collectOperatorReport } from '../../shared/operatorReport.js';
import { appendScanDiagnostic } from '../../shared/scanDiagnosticsJournal.js';

test('Futures keeps reservation-time rejections distinct from earlier strategy and risk approvals',()=>{
  const row={contractId:'CME_ESZ6',status:'blocked',candidate:{instrumentKey:'CME_ESZ6'},
    decision:{status:'paper-approved'},reservation:{status:'blocked',reason:'quote_expired_before_reservation'}};
  const report=summarizeFuturesFunnel([row,row]);
  assert.equal(report.dayTrade.strategyQualified,2);
  assert.equal(report.dayTrade.riskApproved,2);
  assert.equal(report.dayTrade.reservationsCreated,0);
  assert.equal(report.dayTrade.reservationRejected,2);
  assert.deepEqual(report.dayTrade.topRejectionReasons,[{reason:'quote_expired_before_reservation',count:1}]);
});

test('operator retains Futures decision clocks and actual quote ages from saved scans',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'omnimod-futures-timing-report-'));
  try{
    const now=Date.parse('2026-10-06T15:00:00Z');
    const decisionTiming={positionMonitoringStartedAt:new Date(now).toISOString(),
      positionMonitoringCompletedAt:new Date(now+8_000).toISOString(),entryFeedStartedAt:new Date(now+8_000).toISOString(),
      entryFeedCompletedAt:new Date(now+9_000).toISOString(),decisions:[{contractId:'CME_ESZ6',quoteAgeMs:100,riskQuoteAgeMs:6_100}]};
    await appendScanDiagnostic('futures',{decisionTiming},{now,directory:join(dir,'futures','data')});
    const report=await collectOperatorReport({rootDir:dir,stocksDataDir:join(dir,'stocks'),cryptoDataDir:join(dir,'crypto'),
      ledgerPath:join(dir,'ledger.json'),now});
    assert.deepEqual(report.bots.futures.decisionTiming,decisionTiming);
  }finally{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\'));await rm(dir,{recursive:true,force:true});}
});
