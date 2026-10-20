import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('research store appends versioned features, lifecycle events, and bars', async () => {
  const temporaryData = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-stocks-research-'));
  process.env.OMNIMOD_STOCKS_DATA_DIR = temporaryData;
  try {
    const store = await import('../src/researchStore.js');
    const { paths } = await import('../src/storage.js');
    const now = new Date('2026-07-21T15:00:00.000Z');
    const asset = {
      symbol: 'NVDA', price: 150, provider: 'Yahoo Chart', providerQuoteCount: 2,
      liveProviderQuoteCount: 2, providerAgreement: 98, spreadBps: 8, quoteImbalance: 0.1,
      dataQuality: 85, freshness: 'live/delayed', model: { version: '3.0', score: 82 },
      secDataStatus: 'available', corporateActionDataStatus: 'credentials_missing', macroDataStatus: 'partial', macroComponentsAvailable: 2,
      macroStress: 14, manualCatalysts: [{ id: 'event-1', eventType: 'earnings', direction: 'negative', expectedness: 'scheduled', horizon: 'intraday', impact: 'high',
        sourceUrl: 'https://example.com/filing', startsAt: '2026-07-21T14:00:00Z', endsAt: '2026-07-21T16:00:00Z', reason: 'Earnings release' }],
      marketMinute: 650, rsi14: 64, relativeVolume: 1.5
    };
    await store.recordFeatureSnapshot({
      guildId: 'test', assets: [asset], analysis: { candidates: [], watchCandidates: [], rejections: { NVDA: ['spread too wide'] } }, now
    });
    await store.recordPredictionEvents('test', [{ type: 'created', occurredAt: now.toISOString(), prediction: { id: 'p1', symbol: 'NVDA', status: 'tracking' } }]);
    const researchBar = { symbol: 'NVDA', timestamp: Math.floor(now.getTime() / 1000), open: 149, high: 151, low: 148, close: 150, volume: 1000 };
    await store.recordMarketBars('alpaca-iex', [researchBar]);
    await store.recordMarketBars('alpaca-iex', [researchBar]);
    const barFile = paths.researchBars('alpaca-iex', '2026-07-21');
    assert.equal((await fs.readFile(barFile, 'utf8')).trim().split(/\r?\n/).length, 1,
      'retrying a page after the bars were saved but before its checkpoint must not duplicate an identical row');
    await store.recordMarketBars('alpaca-iex', [{ ...researchBar, close: 149.5 }]);
    assert.equal((await fs.readFile(barFile, 'utf8')).trim().split(/\r?\n/).length, 2,
      'a provider correction is retained as a distinct revision instead of being dropped');
    const revisions = (await fs.readFile(barFile, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(revisions[1].updated, true, 'a changed value for the same provider/symbol/time is marked as an update');
    const stats = await store.researchStoreStats();
    assert.equal(stats.files, 3);
    const featureLine = JSON.parse((await fs.readFile(paths.researchFeatures('2026-07-21'), 'utf8')).trim());
    assert.equal(featureLine.schemaVersion, 3);
    assert.ok(featureLine.snapshotId);
    assert.equal(featureLine.classification, 'rejected');
    assert.deepEqual(featureLine.rejectionReasons, ['spread too wide']);
    assert.deepEqual(featureLine.rejectionCodes, ['spread_too_wide']);
    assert.deepEqual(featureLine.stageRejections, [{ stage: 'technical', reasonCode: 'spread_too_wide', reason: 'spread too wide' }]);
    assert.equal(featureLine.eventRisk.secDataStatus, 'available');
    assert.equal(featureLine.eventRisk.corporateActionDataStatus, 'credentials_missing');
    assert.equal(featureLine.macro.status, 'partial');
    assert.equal(featureLine.macro.componentsAvailable, 2);
    assert.equal(featureLine.eventRisk.manualCatalysts[0].eventType, 'earnings');
    assert.equal(featureLine.eventRisk.manualCatalysts[0].direction, 'negative');
    assert.equal(featureLine.eventRisk.manualCatalysts[0].id, 'event-1');
    assert.equal(featureLine.eventRisk.manualCatalysts[0].sourceUrl, 'https://example.com/filing');
    assert.equal(featureLine.eventRisk.manualCatalysts[0].endsAt, '2026-07-21T16:00:00Z');
    const pruned = await store.pruneResearchStore(30, new Date('2035-01-01T00:00:00.000Z'));
    assert.equal(pruned.removed, 3);
  } finally {
    await fs.rm(temporaryData, { recursive: true, force: true });
  }
});

test('scan research dispositions preserve confirmation, model, risk, and approval outcomes per symbol', async () => {
  const { buildResearchDispositions } = await import('../src/researchStore.js');
  const asset = (symbol, decision = 'BUY') => ({ symbol, ensemble: { decision, reason: `Decision for ${symbol}` } });
  const analysis = {
    rejectionRecords: [
      { symbol: 'TECH', stage: 'technical', reasonCodes: ['spread_too_wide'], reasons: ['spread too wide'] },
      { symbol: 'WATCH', stage: 'technical', reasonCodes: ['relative_volume'], reasons: ['relative volume'] }
    ],
    watchCandidates: [{ symbol: 'WATCH', rejectionReasons: ['relative volume'] }]
  };
  const candidates = ['PENDING', 'MODEL', 'RISK', 'APPROVED'].map((symbol) => asset(symbol, symbol === 'MODEL' ? 'NO_EDGE' : 'BUY'));
  const dispositions = buildResearchDispositions({ analysis, candidates,
    confirmed: candidates.filter((row) => row.symbol !== 'PENDING'),
    modelRejected: [candidates.find((row) => row.symbol === 'MODEL')],
    portfolio: { rejected: [{ symbol: 'RISK', reason: 'Daily loss limit reached.' }] },
    selected: [candidates.find((row) => row.symbol === 'APPROVED')] });

  assert.equal(dispositions.get('TECH').classification, 'technical_rejected');
  assert.equal(dispositions.get('TECH').stageRejections[0].reasonCode, 'spread_too_wide');
  assert.equal(dispositions.get('WATCH').classification, 'technical_watch');
  assert.equal(dispositions.get('PENDING').classification, 'confirmation_pending');
  assert.equal(dispositions.get('PENDING').stageRejections[0].reasonCode, 'confirmation_scans_pending');
  assert.equal(dispositions.get('MODEL').classification, 'model_rejected');
  assert.equal(dispositions.get('MODEL').stageRejections[0].reasonCode, 'model_no_edge');
  assert.equal(dispositions.get('RISK').classification, 'risk_rejected');
  assert.equal(dispositions.get('RISK').stageRejections[0].reasonCode, 'risk_daily_loss_limit_reached');
  assert.equal(dispositions.get('APPROVED').classification, 'risk_approved');
  assert.equal(dispositions.get('APPROVED').lastPassedStage, 'risk');
});
