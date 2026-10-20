import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { config, dataDir } from './config.js';
import { extractModelFeatures, featureObject } from './modelFeatures.js';
import { paths } from './storage.js';
import { localDateKey } from './time.js';

let writeQueue = Promise.resolve();

function enqueue(operation) {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.catch(() => {});
  return result;
}

function safeDateKey(timestamp = new Date()) {
  return localDateKey(timestamp instanceof Date ? timestamp : new Date(timestamp), config.marketTimezone);
}

async function appendLines(file, rows) {
  if (!rows.length) return;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.appendFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function acquireMarketBarsFileLock(file, timeoutMs = 30_000) {
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  const nonce = randomUUID();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  while (true) {
    try {
      const handle = await fs.open(lockFile, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), nonce, startedAt: new Date().toISOString() }));
      } catch (error) {
        await handle.close().catch(() => {});
        await fs.unlink(lockFile).catch(() => {});
        throw error;
      }
      return async () => {
        await handle.close().catch(() => {});
        try {
          const owner = JSON.parse(await fs.readFile(lockFile, 'utf8'));
          if (owner?.nonce === nonce) await fs.unlink(lockFile);
        } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      let contention = error?.code === 'EEXIST';
      if (!contention && process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
        try { await fs.stat(lockFile); contention = true; }
        catch (statError) { if (statError?.code === 'ENOENT') continue; throw error; }
      }
      if (!contention) throw error;
      if (Date.now() >= deadline) throw new Error(`Historical market-bar file is locked; no rows were written: ${path.basename(file)}.`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
}

async function readMarketBarRowsForUpdate(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  if (text && !text.endsWith('\n')) {
    const lastLineStart = text.lastIndexOf('\n') + 1;
    try {
      JSON.parse(text.slice(lastLineStart));
      text += '\n';
    } catch {
      // A process may die while appendFile writes the final JSONL record. Only
      // discard that unterminated tail; malformed complete lines remain fatal.
      text = text.slice(0, lastLineStart);
    }
    await fs.writeFile(file, text, { encoding: 'utf8', mode: 0o600 });
  }
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`Research market-bar file contains a malformed complete row: ${path.basename(file)}.`, { cause: error }); }
  });
}

function stableId(parts) {
  return createHash('sha256').update(parts.map((value) => String(value ?? '')).join('|')).digest('hex').slice(0, 24);
}

function researchAsset(asset, metadata = {}) {
  return {
    schemaVersion: 3,
    recordType: 'feature_snapshot',
    snapshotId: stableId([metadata.guildId, metadata.recordedAt, asset.symbol, metadata.reason]),
    recordedAt: metadata.recordedAt,
    guildId: metadata.guildId,
    reason: metadata.reason,
    symbol: asset.symbol,
    provider: asset.provider,
    providerQuoteCount: asset.providerQuoteCount,
    liveProviderQuoteCount: asset.liveProviderQuoteCount,
    providerAgreement: asset.providerAgreement,
    providerDispersionBps: asset.providerDispersionBps,
    microstructureProvider: asset.microstructureProvider || '',
    bidPrice: asset.bidPrice || 0,
    askPrice: asset.askPrice || 0,
    spreadBps: asset.spreadBps ?? null,
    quoteImbalance: asset.quoteImbalance || 0,
    spreadMean1m: asset.spreadMean1m || asset.spreadBps || 0,
    spreadMean5m: asset.spreadMean5m || asset.spreadBps || 0,
    spreadMean15m: asset.spreadMean15m || asset.spreadBps || 0,
    spreadPercentile15m: asset.spreadPercentile15m ?? 0.5,
    spreadAcceleration: asset.spreadAcceleration || 0,
    quoteImbalance1m: asset.quoteImbalance1m ?? asset.quoteImbalance ?? 0,
    quoteImbalance5m: asset.quoteImbalance5m ?? asset.quoteImbalance ?? 0,
    quoteImbalance15m: asset.quoteImbalance15m ?? asset.quoteImbalance ?? 0,
    tradeFlow1m: asset.tradeFlow1m || 0,
    tradeFlow5m: asset.tradeFlow5m || 0,
    tradeFlow15m: asset.tradeFlow15m || 0,
    quoteAgeSeconds: asset.quoteAgeSeconds ?? null,
    tradeAgeSeconds: asset.tradeAgeSeconds ?? null,
    luldDistanceBps: asset.luldDistanceBps ?? null,
    halted: Boolean(asset.halted),
    price: asset.price,
    livePrice: asset.livePrice || asset.price,
    averageDailyVolume: asset.averageDailyVolume ?? null,
    livePriceProvider: asset.livePriceProvider || asset.provider,
    lastUpdated: asset.lastUpdated,
    freshness: asset.freshness,
    marketState: asset.marketState,
    marketRegime: asset.marketRegime || 'unknown',
    marketMinute: asset.marketMinute ?? null,
    sector: asset.sector || '',
    dataQuality: asset.dataQuality,
    modelVersion: metadata.ensemble?.modelId || metadata.ensemble?.expertId || metadata.ensemble?.source || (asset.model?.version ? `rule-${asset.model.version}` : 'unknown'),
    ruleModelVersion: asset.model?.version || '',
    discoveryVersion: asset.discoveryVersion || 'configured-or-legacy',
    ruleScore: asset.model?.score ?? asset.score ?? null,
    classification: metadata.classification || 'unclassified',
    lastPassedStage: metadata.lastPassedStage || '',
    rejectionReasons: metadata.rejectionReasons || [],
    rejectionCodes: metadata.rejectionCodes || [],
    stageRejections: metadata.stageRejections || [],
    eventRisk: {
      recentSecForm: asset.recentSecForm || '', secFilingAgeHours: asset.secFilingAgeHours ?? null,
      secFilingRisk: asset.secFilingRisk || 0, daysToCorporateAction: asset.daysToCorporateAction ?? null,
      corporateActionType: asset.corporateActionType || '', corporateActionRisk: asset.corporateActionRisk || 0,
      secDataStatus: asset.secDataStatus || 'unknown', corporateActionDataStatus: asset.corporateActionDataStatus || 'unknown',
      manualCatalysts: (Array.isArray(asset.manualCatalysts) ? asset.manualCatalysts : []).slice(0, 5).map((row) => ({
        id: row.id || '',
        eventType: row.eventType || 'other', direction: row.direction || 'unknown', expectedness: row.expectedness || 'unknown',
        horizon: row.horizon || 'unknown', impact: row.impact || 'unknown', sourceUrl: row.sourceUrl || '',
        startsAt: row.startsAt || '', endsAt: row.endsAt || '', reason: String(row.reason || '').slice(0, 300)
      })),
      nextEarningsDate: asset.nextEarningsDate || '', daysToEarnings: asset.daysToEarnings ?? null
    },
    fundamentals: {
      revenueGrowthYoY: asset.revenueGrowthYoY ?? null, netIncomeGrowthYoY: asset.netIncomeGrowthYoY ?? null,
      sharesGrowthYoY: asset.sharesGrowthYoY ?? null
    },
    macro: {
      vix: asset.vix ?? null, yieldCurve10y2y: asset.yieldCurve10y2y ?? null,
      creditSpread: asset.creditSpread ?? null, macroStress: asset.macroStress ?? null,
      status: asset.macroDataStatus || 'unknown', componentsAvailable: asset.macroComponentsAvailable ?? null,
      observedAt: asset.macroObservedAt || ''
    },
    ensemble: metadata.ensemble || null,
    featureVersion: extractModelFeatures(asset).version,
    features: featureObject(asset)
  };
}

function normalizedReasonCode(value) {
  return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unknown';
}

export function buildResearchDispositions({ analysis = {}, candidates = [], confirmed = [], modelRejected = [], portfolio = {}, selected = [] } = {}) {
  const confirmedSymbols = new Set(confirmed.map((asset) => asset.symbol));
  const modelRejectedBySymbol = new Map(modelRejected.map((asset) => [asset.symbol, asset]));
  const portfolioRejectedBySymbol = new Map((portfolio.rejected || []).map((row) => [row.symbol, row]));
  const selectedSymbols = new Set(selected.map((asset) => asset.symbol));
  const technicalBySymbol = new Map();
  for (const row of analysis.rejectionRecords || []) {
    const details = (row.reasons || []).map((reason, index) => ({ stage: row.stage || 'technical',
      reasonCode: row.reasonCodes?.[index] || normalizedReasonCode(reason), reason: String(reason) }));
    technicalBySymbol.set(row.symbol, [...(technicalBySymbol.get(row.symbol) || []), ...details]);
  }
  const output = new Map();
  for (const asset of analysis.watchCandidates || []) output.set(asset.symbol, {
    classification: 'technical_watch', lastPassedStage: 'candidate_filter', stageRejections: technicalBySymbol.get(asset.symbol) || [],
  });
  for (const asset of candidates) {
    let classification = 'model_approved', lastPassedStage = 'confirmation';
    let finalRejection = null;
    if (!confirmedSymbols.has(asset.symbol)) {
      classification = 'confirmation_pending'; lastPassedStage = 'technical';
      finalRejection = { stage: 'confirmation', reasonCode: 'confirmation_scans_pending',
        reason: `Candidate has not yet completed the configured consecutive-scan confirmation requirement.` };
    } else if (modelRejectedBySymbol.has(asset.symbol)) {
      const rejected = modelRejectedBySymbol.get(asset.symbol);
      const decision = rejected.ensemble?.decision || 'NO_MODEL_DECISION';
      classification = 'model_rejected';
      finalRejection = { stage: 'model', reasonCode: `model_${normalizedReasonCode(decision)}`,
        reason: rejected.ensemble?.reason || 'No validated model BUY approval.' };
    } else if (portfolioRejectedBySymbol.has(asset.symbol)) {
      const rejected = portfolioRejectedBySymbol.get(asset.symbol);
      classification = 'risk_rejected';
      finalRejection = { stage: 'risk', reasonCode: `risk_${normalizedReasonCode(rejected.reason)}`,
        reason: String(rejected.reason || 'Risk approval did not pass.') };
    } else if (selectedSymbols.has(asset.symbol)) {
      classification = 'risk_approved'; lastPassedStage = 'risk';
    }
    output.set(asset.symbol, { classification, lastPassedStage,
      stageRejections: [...(technicalBySymbol.get(asset.symbol) || []), ...(finalRejection ? [finalRejection] : [])] });
  }
  for (const [symbol, details] of technicalBySymbol) if (!output.has(symbol)) output.set(symbol, {
    classification: 'technical_rejected', lastPassedStage: 'discovery', stageRejections: details
  });
  return output;
}

export function recordFeatureSnapshot({ guildId, assets = [], analysis = {}, decisions = new Map(), dispositions = new Map(), reason = 'scan', now = new Date() }) {
  const recordedAt = now.toISOString();
  const qualified = new Set((analysis.candidates || []).map((asset) => asset.symbol));
  const watches = new Map((analysis.watchCandidates || []).map((asset) => [asset.symbol, asset.rejectionReasons || []]));
  const technicalDetails = new Map();
  for (const row of analysis.rejectionRecords || []) technicalDetails.set(row.symbol, [...(technicalDetails.get(row.symbol) || []),
    ...(row.reasons || []).map((reason, index) => ({ stage: row.stage || 'technical', reasonCode: row.reasonCodes?.[index] || normalizedReasonCode(reason), reason: String(reason) }))]);
  for (const [symbol, reasons] of Object.entries(analysis.rejections || {})) {
    const saved = technicalDetails.get(symbol) || [];
    for (const reason of reasons || []) if (!saved.some((row) => row.reason === String(reason)))
      saved.push({ stage: 'technical', reasonCode: normalizedReasonCode(reason), reason: String(reason) });
    if (saved.length) technicalDetails.set(symbol, saved);
  }
  const rows = assets.map((asset) => {
    const disposition = dispositions.get(asset.symbol) || {};
    const priorReasons = analysis.rejections?.[asset.symbol] || watches.get(asset.symbol) || [];
    const stageRejections = disposition.stageRejections || technicalDetails.get(asset.symbol) || [];
    const rejectionReasons = [...new Set([...priorReasons, ...stageRejections.map((row) => row.reason)])];
    const classification = disposition.classification || (qualified.has(asset.symbol) ? 'quality_gated' : watches.has(asset.symbol) ? 'watch_only' : rejectionReasons.length ? 'rejected' : 'screened');
    return researchAsset(asset, {
      guildId,
      recordedAt,
      reason,
      classification,
      rejectionReasons,
      lastPassedStage: disposition.lastPassedStage || '',
      rejectionCodes: stageRejections.map((row) => row.reasonCode),
      stageRejections,
      ensemble: decisions.get(asset.symbol) || null
    });
  });
  return enqueue(() => appendLines(paths.researchFeatures(safeDateKey(now)), rows));
}

function predictionEventRow(guildId, eventType, prediction, occurredAt, details = {}) {
  return {
    schemaVersion: 1,
    recordType: 'prediction_event',
    guildId,
    eventType,
    occurredAt: occurredAt || new Date().toISOString(),
    predictionId: prediction?.id || '',
    symbol: prediction?.symbol || '',
    status: prediction?.status || '',
    modelVersion: prediction?.modelVersion || '',
    ensembleDecision: prediction?.ensemble?.decision || prediction?.ensembleDecision || '',
    ensembleModelId: prediction?.ensembleModelId || prediction?.ensemble?.modelId || '',
    researchModelId: prediction?.researchModelId || '',
    expertId: prediction?.expertId || prediction?.ensemble?.expertId || '',
    entryPrice: prediction?.entryPrice || 0,
    exitPrice: prediction?.exitPrice || 0,
    netReturnPct: prediction?.netReturnPct ?? null,
    realizedR: prediction?.realizedR ?? null,
    details
  };
}

export function recordPredictionEvents(guildId, events = []) {
  const rows = events.map((entry) => predictionEventRow(guildId, entry.type || entry.eventType || 'unknown', entry.prediction || entry, entry.occurredAt, { color: entry.color || '', description: entry.description || '' }));
  const groups = Map.groupBy ? Map.groupBy(rows, (row) => safeDateKey(row.occurredAt)) : rows.reduce((map, row) => {
    const key = safeDateKey(row.occurredAt); const current = map.get(key) || []; current.push(row); map.set(key, current); return map;
  }, new Map());
  return enqueue(async () => {
    for (const [dateKey, group] of groups) await appendLines(paths.researchEvents(dateKey), group);
  });
}

export function recordPredictionCreated(guildId, predictions = []) {
  return recordPredictionEvents(guildId, predictions.map((prediction) => ({ type: 'created', prediction, occurredAt: prediction.createdAt })));
}

export function recordCounterfactualLabels(rows = []) {
  const groups = rows.reduce((map, row) => {
    const key = safeDateKey(row.recordedAt || row.entryAt || new Date());
    const current = map.get(key) || []; current.push(row); map.set(key, current); return map;
  }, new Map());
  return enqueue(async () => {
    for (const [dateKey, group] of groups) await appendLines(paths.researchLabels(dateKey), group);
  });
}

export function recordUniverseRows(dateKey, rows = []) {
  return enqueue(() => appendLines(paths.researchUniverse(dateKey), rows));
}

export function recordScanDiagnostic(record = {}) {
  const dateKey = safeDateKey(record.startedAt || record.completedAt || new Date());
  const row = { schemaVersion: 1, recordType: 'scan_diagnostic', ...record };
  return enqueue(() => appendLines(paths.researchDiagnostics(dateKey), [row]));
}

export async function readScanDiagnostics(guildId, limit = 100) {
  const rows = [];
  for (const file of await researchFiles('diagnostics')) {
    rows.push(...(await readJsonLines(file)).filter((row) => row.recordType === 'scan_diagnostic' && row.guildId === String(guildId)));
  }
  return rows.sort((left, right) => String(left.startedAt || '').localeCompare(String(right.startedAt || '')))
    .slice(-Math.max(1, Math.min(500, Number(limit) || 100)));
}

export function recordIntelligenceRows(rows = []) {
  const groups = rows.reduce((map, row) => {
    const key = safeDateKey(row.recordedAt || new Date()); const current = map.get(key) || [];
    current.push(row); map.set(key, current); return map;
  }, new Map());
  return enqueue(async () => {
    for (const [dateKey, group] of groups) await appendLines(paths.researchIntelligence(dateKey), group);
  });
}

export async function readJsonLines(file) {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export async function researchFiles(kind) {
  const directory = path.join(paths.researchRoot(), kind);
  return (await filesRecursive(directory)).filter((file) => file.endsWith('.jsonl')).sort();
}

function marketBarRow(provider, bar, recordedAt = new Date().toISOString()) {
  return {
    schemaVersion: 1,
    recordType: 'market_bar',
    provider,
    recordedAt,
    symbol: bar.symbol,
    timestamp: bar.timestamp,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    tradeCount: bar.tradeCount || 0,
    vwap: bar.vwap || 0,
    updated: Boolean(bar.updated)
  };
}

function marketBarFingerprint(row) {
  return JSON.stringify([row.provider, row.symbol, row.timestamp, row.open, row.high, row.low, row.close,
    row.volume, row.tradeCount, row.vwap]);
}

function marketBarIdentity(row) {
  return JSON.stringify([row.provider, row.symbol, row.timestamp]);
}

export function recordMarketBars(provider, bars = []) {
  const recordedAt = new Date().toISOString();
  const groups = bars.reduce((map, bar) => {
    const timestamp = bar?.timestamp ? new Date(Number(bar.timestamp) * (Number(bar.timestamp) < 1e12 ? 1000 : 1)) : new Date();
    const key = safeDateKey(timestamp); const current = map.get(key) || [];
    current.push(marketBarRow(provider, bar, recordedAt)); map.set(key, current); return map;
  }, new Map());
  return enqueue(async () => {
    for (const [dateKey, rows] of groups) {
      const file = paths.researchBars(provider, dateKey);
      const release = await acquireMarketBarsFileLock(file);
      try {
        const existing = await readMarketBarRowsForUpdate(file);
        const marketRows = existing.filter((row) => row.recordType === 'market_bar');
        const seen = new Set(marketRows.map(marketBarFingerprint));
        const latestByIdentity = new Map(marketRows.map((row) => [marketBarIdentity(row), marketBarFingerprint(row)]));
        const novel = rows.filter((row) => {
          const fingerprint = marketBarFingerprint(row);
          if (seen.has(fingerprint)) return false;
          if (latestByIdentity.has(marketBarIdentity(row))) row.updated = true;
          seen.add(fingerprint);
          latestByIdentity.set(marketBarIdentity(row), fingerprint);
          return true;
        });
        await appendLines(file, novel);
      } finally { await release(); }
    }
  });
}

export function recordMarketBar(provider, bar) {
  return recordMarketBars(provider, [bar]);
}

async function filesRecursive(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesRecursive(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

export async function researchStoreStats() {
  const root = paths.researchRoot();
  const files = await filesRecursive(root);
  const stats = (await Promise.all(files.map(async (file) => ({ file, stat: await fs.stat(file).catch(() => null) })))).filter((row) => row.stat);
  const jsonl = stats.filter((row) => row.file.endsWith('.jsonl'));
  return {
    root,
    files: jsonl.length,
    bytes: jsonl.reduce((sum, row) => sum + row.stat.size, 0),
    oldestAt: jsonl.length ? new Date(Math.min(...jsonl.map((row) => row.stat.mtimeMs))).toISOString() : '',
    newestAt: jsonl.length ? new Date(Math.max(...jsonl.map((row) => row.stat.mtimeMs))).toISOString() : ''
  };
}

export async function pruneResearchStore(retentionDays = config.researchRetentionDays, now = new Date()) {
  const root = path.resolve(paths.researchRoot());
  const expectedPrefix = `${path.resolve(dataDir)}${path.sep}`;
  if (!root.startsWith(expectedPrefix)) throw new Error('Research retention path is outside the configured data directory.');
  const cutoff = now.getTime() - Math.max(30, Number(retentionDays) || 730) * 24 * 60 * 60_000;
  const files = await filesRecursive(root);
  let removed = 0;
  for (const file of files) {
    const match = path.basename(file).match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!match) continue;
    const timestamp = new Date(`${match[1]}T12:00:00Z`).getTime();
    if (Number.isFinite(timestamp) && timestamp < cutoff) {
      await fs.unlink(file);
      removed += 1;
    }
  }
  return { removed, cutoff: new Date(cutoff).toISOString() };
}
