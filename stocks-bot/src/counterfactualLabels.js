import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { marketCloseTime } from './time.js';
import { readJsonLines, recordCounterfactualLabels, researchFiles } from './researchStore.js';
import { classifyStockResearchMetadata } from './researchTaxonomy.js';

export const COUNTERFACTUAL_LABEL_VERSION = 2;
export const COUNTERFACTUAL_HORIZONS = Object.freeze([30, 90, 240]);

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const finite = (value, fallback = 0) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback;

function rowId(snapshot) {
  if (snapshot.snapshotId) return snapshot.snapshotId;
  return createHash('sha256').update([snapshot.guildId, snapshot.recordedAt, snapshot.symbol, snapshot.reason].join('|')).digest('hex').slice(0, 24);
}

function labelId(snapshotId, horizonMinutes) {
  return createHash('sha256').update(`${snapshotId}|${horizonMinutes}|${COUNTERFACTUAL_LABEL_VERSION}`).digest('hex').slice(0, 24);
}

function feature(snapshot, name, fallback = 0) {
  return finite(snapshot.features?.[name], fallback);
}

export function counterfactualTradePlan(snapshot, horizonMinutes, options = {}) {
  const spreadBps = Math.max(0, finite(snapshot.spreadBps));
  const configuredSlippage = Math.max(0, finite(options.slippageBps, config.counterfactualSlippageBps));
  const livePrice = finite(snapshot.livePrice, snapshot.price);
  const offer = finite(snapshot.askPrice);
  const entryBase = offer > 0 ? offer : livePrice;
  const estimatedHalfSpread = offer > 0 ? 0 : spreadBps / 2;
  const entryPrice = entryBase * (1 + (configuredSlippage + estimatedHalfSpread) / 10_000);
  const exitCostBps = configuredSlippage + spreadBps / 2;
  const atrPct = clamp(feature(snapshot, 'dailyAtrPercent', 2), 0.4, 8);
  const intradayAtrPct = clamp(feature(snapshot, 'intradayAtrPercent', atrPct / 8), 0.05, 5);
  const stopPct = clamp(atrPct * 0.38, 0.55, 3);
  const expectedMovePct = intradayAtrPct * Math.sqrt(Math.max(1, horizonMinutes / 5));
  const targetPct = clamp(Math.min(stopPct * 1.25, expectedMovePct * 1.05), 0.55, 2.5);
  return {
    entryPrice,
    entryBase,
    entryCostBps: configuredSlippage + estimatedHalfSpread,
    exitCostBps,
    stopPct,
    targetPct,
    stopPrice: entryPrice * (1 - stopPct / 100),
    targetPrice: entryPrice * (1 + targetPct / 100),
    riskPerShare: entryPrice * stopPct / 100
  };
}

function normalizedBars(rows = []) {
  const byTimestamp = new Map();
  for (const row of rows) {
    const timestamp = finite(row.timestamp);
    if (!timestamp || ![row.open, row.high, row.low, row.close].every((value) => finite(value) > 0)
      || Number(row.high) < Math.max(Number(row.open), Number(row.close), Number(row.low))
      || Number(row.low) > Math.min(Number(row.open), Number(row.close))) continue;
    byTimestamp.set(timestamp, { ...row, timestamp, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close) });
  }
  return [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp);
}

export function labelCounterfactualSnapshot(snapshot, bars = [], options = {}) {
  const snapshotId = rowId(snapshot);
  const recordedMs = Date.parse(snapshot.recordedAt);
  if (!snapshotId || !Number.isFinite(recordedMs)) return [];
  const future = normalizedBars(bars).filter((bar) => bar.timestamp * 1000 >= recordedMs);
  if (!future.length) return [];
  // Research-store Alpaca bars are one-minute bars. A missing bar is not a
  // longer candle and must not be mistaken for continuous path coverage.
  const inferredIntervalMs = Math.max(1, finite(options.barIntervalMinutes, 1)) * 60_000;
  const closeMs = marketCloseTime(new Date(recordedMs)).getTime();
  const researchMetadata = classifyStockResearchMetadata(snapshot);
  return (options.horizons || COUNTERFACTUAL_HORIZONS).flatMap((horizonMinutes) => {
    const naturalDeadline = recordedMs + horizonMinutes * 60_000;
    // Round the exit down to a completed candle boundary. Never consume the
    // trailing partial candle, whose high/low would extend beyond the horizon.
    const deadlineMs = Math.floor(Math.min(naturalDeadline, closeMs) / inferredIntervalMs) * inferredIntervalMs;
    // Bars are timestamped at their opening instant. A bar that opens exactly at
    // the deadline contains prices observed after the allowed horizon.
    const path = future.filter((bar) => bar.timestamp * 1000 + inferredIntervalMs <= deadlineMs);
    const coverageEndMs = (path.at(-1)?.timestamp || 0) * 1000 + inferredIntervalMs;
    if (!path.length || coverageEndMs < deadlineMs || path[0].timestamp * 1000 > Math.ceil(recordedMs / inferredIntervalMs) * inferredIntervalMs
      || path.some((bar, index) => index > 0 && (bar.timestamp - path[index - 1].timestamp) * 1000 > inferredIntervalMs)) return [];
    const entryMs = path[0].timestamp * 1000;
    // Intraminute feature snapshots cannot observe a path starting inside an
    // OHLC candle. Defer the simulated entry to the next full candle's open,
    // with the last known spread plus slippage rather than an earlier ask.
    const deferredEntry = entryMs > recordedMs;
    const plan = counterfactualTradePlan(deferredEntry ? { ...snapshot, livePrice: path[0].open, askPrice: 0 } : snapshot, horizonMinutes, options);
    if (!(plan.entryPrice > 0)) return [];
    let terminal = 'timeout'; let rawExitPrice = path.at(-1).close; let terminalAt = new Date(deadlineMs).toISOString();
    let maxFavorablePct = -Infinity; let maxAdversePct = Infinity; let ambiguousBarrier = false;
    for (const bar of path) {
      maxFavorablePct = Math.max(maxFavorablePct, (bar.high / plan.entryPrice - 1) * 100);
      maxAdversePct = Math.min(maxAdversePct, (bar.low / plan.entryPrice - 1) * 100);
      const stopHit = bar.low <= plan.stopPrice;
      const targetHit = bar.high >= plan.targetPrice;
      if (stopHit && targetHit) {
        terminal = 'stop'; rawExitPrice = Math.min(plan.stopPrice, bar.open); ambiguousBarrier = true;
      } else if (stopHit) {
        terminal = 'stop'; rawExitPrice = Math.min(plan.stopPrice, bar.open);
      } else if (targetHit) {
        terminal = 'target'; rawExitPrice = plan.targetPrice;
      } else continue;
      terminalAt = new Date(Math.min(deadlineMs, bar.timestamp * 1000 + inferredIntervalMs)).toISOString();
      break;
    }
    const exitPrice = rawExitPrice * (1 - plan.exitCostBps / 10_000);
    const netReturnPct = (exitPrice / plan.entryPrice - 1) * 100;
    const realizedR = netReturnPct / Math.max(0.01, plan.stopPct);
    const hasExecutableQuote = Number(snapshot.askPrice) > 0
      && Number(snapshot.bidPrice) > 0
      && Number(snapshot.askPrice) >= Number(snapshot.bidPrice)
      && snapshot.spreadBps !== null && snapshot.spreadBps !== undefined && Number.isFinite(Number(snapshot.spreadBps));
    const executable = !snapshot.halted && hasExecutableQuote && plan.entryPrice > 0
      && Number(snapshot.spreadBps) <= finite(options.maxSpreadBps, 500);
    return [{
      schemaVersion: 1,
      recordType: 'counterfactual_label',
      labelVersion: COUNTERFACTUAL_LABEL_VERSION,
      labelId: labelId(snapshotId, horizonMinutes),
      snapshotId,
      guildId: snapshot.guildId || '',
      symbol: snapshot.symbol,
      recordedAt: snapshot.recordedAt,
      entryAt: new Date(entryMs).toISOString(),
      deferredEntry,
      effectiveHorizonSeconds: (deadlineMs - entryMs) / 1000,
      terminalAt,
      horizonMinutes,
      classification: snapshot.classification || 'unknown',
      marketRegime: snapshot.marketRegime || 'unknown',
      sessionBucket: finite(snapshot.marketMinute) < 630 ? 'open' : finite(snapshot.marketMinute) < 840 ? 'midday' : 'late',
      ...researchMetadata,
      executable,
      terminal,
      ambiguousBarrier,
      entryPrice: plan.entryPrice,
      exitPrice,
      stopPrice: plan.stopPrice,
      targetPrice: plan.targetPrice,
      stopPct: plan.stopPct,
      targetPct: plan.targetPct,
      entryCostBps: plan.entryCostBps,
      exitCostBps: plan.exitCostBps,
      maxFavorablePct: Number.isFinite(maxFavorablePct) ? maxFavorablePct : 0,
      maxAdversePct: Number.isFinite(maxAdversePct) ? maxAdversePct : 0,
      netReturnPct,
      realizedR,
      profitable: netReturnPct > 0,
      targetHit: terminal === 'target',
      labeledAt: new Date().toISOString()
    }];
  });
}

function datedFile(file) {
  return path.basename(file).match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1] || '';
}

function recentFiles(files, lookbackDays, now = new Date()) {
  const cutoff = new Date(now.getTime() - Math.max(3, Number(lookbackDays) || config.labelLookbackDays) * 24 * 60 * 60_000)
    .toISOString().slice(0, 10);
  return files.filter((file) => !datedFile(file) || datedFile(file) >= cutoff);
}

export async function labelPendingResearch(options = {}) {
  const lookbackDays = Math.max(3, Number(options.lookbackDays) || config.labelLookbackDays);
  const [featureFiles, labelFiles] = await Promise.all([researchFiles('features'), researchFiles('labels')]);
  const [snapshots, existingLabels] = await Promise.all([
    Promise.all(recentFiles(featureFiles, lookbackDays).map(readJsonLines)).then((rows) => rows.flat()),
    Promise.all(recentFiles(labelFiles, lookbackDays).map(readJsonLines)).then((rows) => rows.flat())
  ]);
  const provider = String(options.provider || `alpaca-${config.alpacaDataFeed}`).toLowerCase();
  const barFiles = recentFiles((await researchFiles('bars'))
    .filter((file) => path.basename(path.dirname(file)).toLowerCase() === provider), lookbackDays);
  const bars = (await Promise.all(barFiles.map(readJsonLines))).flat();
  const barsBySymbol = bars.reduce((map, bar) => {
    const current = map.get(bar.symbol) || []; current.push(bar); map.set(bar.symbol, current); return map;
  }, new Map());
  const existing = new Set(existingLabels.map((row) => row.labelId));
  const eligibleSnapshots = snapshots.filter((row) => !options.guildId || row.guildId === options.guildId)
    .slice(-(Math.max(1, Number(options.maxSnapshots)) || snapshots.length));
  const labels = [];
  for (const snapshot of eligibleSnapshots) {
    for (const label of labelCounterfactualSnapshot(snapshot, barsBySymbol.get(snapshot.symbol) || [], options)) {
      if (!existing.has(label.labelId)) { existing.add(label.labelId); labels.push({ ...label, barProvider: provider }); }
    }
  }
  await recordCounterfactualLabels(labels);
  return {
    snapshots: eligibleSnapshots.length,
    symbolsWithBars: barsBySymbol.size,
    existingLabels: existingLabels.length,
    labelsAdded: labels.length,
    provider,
    lookbackDays,
    byHorizon: Object.fromEntries(COUNTERFACTUAL_HORIZONS.map((horizon) => [horizon, labels.filter((row) => row.horizonMinutes === horizon).length]))
  };
}
