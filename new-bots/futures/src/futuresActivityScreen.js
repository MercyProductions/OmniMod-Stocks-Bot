import { createHash } from 'node:crypto';

export const FUTURES_ACTIVITY_VERSION = 'futures-broad-minute-activity-v1';
const MINUTE = 60_000;
const numeric = (value) => (typeof value === 'number' || typeof value === 'string') && String(value).trim()
  && Number.isFinite(Number(value)) ? Number(value) : null;
const integerId = (value) => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? String(value) : null;
const utcDate = (time) => new Date(time).toISOString().slice(0, 10);
const pct = (difference, reference) => reference !== 0 && Number.isFinite(reference)
  && Number.isFinite(difference / Math.abs(reference) * 100) ? difference / Math.abs(reference) * 100 : null;

export function futuresActivityDirectoryFingerprint(directory) {
  return createHash('sha256').update(JSON.stringify({ version: directory?.diagnostics?.version,
    source: directory?.archive?.sha256, observedFrom: directory?.diagnostics?.observedFrom,
    observedThrough: directory?.diagnostics?.observedThroughExclusive,
    identities: (directory?.contracts ?? []).map((c) => [c.identity, c.providerRawSymbol, c.providerRoot, c.expiry]) })).digest('hex');
}

/** Eligibility for historical research; never an assertion of current tradeability. */
export function inspectFuturesActivityDirectory(directory, { dataset, now }) {
  if (!directory?.diagnostics?.streamComplete || !['refreshed', 'cached'].includes(directory.status)) return 'directory_not_current';
  if (directory.diagnostics.dataset !== dataset) return 'directory_dataset_mismatch';
  if (String(directory.diagnostics.observedFrom || '').slice(0, 10) !== utcDate(now)) return 'directory_date_mismatch';
  if (!Array.isArray(directory.contracts) || !directory.contracts.length) return 'no_unexpired_directory_contracts';
  const seen = new Set();
  for (const c of directory.contracts) {
    const publisher = integerId(c.providerPublisherId), instrument = integerId(c.providerInstrumentId);
    const identity = `${dataset}:${utcDate(now)}:${publisher}:${instrument}`;
    if (!publisher || !instrument || publisher > 65535 || instrument > 4294967294 || c.identity !== identity
      || c.providerDataset !== dataset || c.providerInstrumentClass !== 'F'
      || typeof c.providerRoot !== 'string' || !c.providerRoot.trim() || typeof c.providerRawSymbol !== 'string' || !c.providerRawSymbol.trim()
      || !Number.isFinite(Date.parse(c.expiry)) || Date.parse(c.expiry) <= now || seen.has(identity)) return 'directory_identity_invalid';
    seen.add(identity);
  }
  return null;
}

/** Streaming bars feed inexpensive features for every reference, with no indicator/history requests per symbol. */
export function createFuturesActivityScreen({ directory, dataset, start, end, now,
  maxCandidates = 20, maxContractsPerRoot = 1, maxBarAgeMs = 180_000 } = {}) {
  const startTime = Date.parse(start), endTime = Date.parse(end);
  if (!Number.isFinite(now) || !Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime
    || endTime > now || startTime % MINUTE || endTime % MINUTE || utcDate(startTime) !== utcDate(endTime - 1)) throw new TypeError('Invalid activity interval.');
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 100
    || !Number.isInteger(maxContractsPerRoot) || maxContractsPerRoot < 1 || maxContractsPerRoot > 3
    || !Number.isFinite(maxBarAgeMs) || maxBarAgeMs <= 0 || maxBarAgeMs > 300_000) throw new TypeError('Invalid activity screen limits.');
  const invalidDirectory = inspectFuturesActivityDirectory(directory, { dataset, now });
  if (invalidDirectory) throw new Error(invalidDirectory);
  const byIdentity = new Map(directory.contracts.map((c) => [c.identity, { contract: c, bars: new Map(), failures: new Set() }]));
  const recordRejections = {}, unrecognized = [], sourceDay = utcDate(startTime);
  let receivedRecords = 0, acceptedRecords = 0, duplicateRecords = 0;
  const rejectRecord = (reason, identity, time) => {
    recordRejections[reason] = (recordRejections[reason] || 0) + 1;
    unrecognized.push({ record: receivedRecords, identity, time: time || null, reason });
  };
  function add(record) {
    receivedRecords++;
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Malformed activity record.');
    const publisher = integerId(record.publisher_id ?? record.hd?.publisher_id), instrument = integerId(record.instrument_id ?? record.hd?.instrument_id);
    const key = publisher && instrument ? `${dataset}:${sourceDay}:${publisher}:${instrument}` : null;
    const target = byIdentity.get(key);
    if (!key) { rejectRecord('invalid_bar_identity', null); return; }
    if (!target) { rejectRecord('outside_outright_directory', key); return; }
    const raw = record.symbol ?? record.raw_symbol;
    const rawTime = record.ts_event ?? record.hd?.ts_event;
    const time = typeof rawTime === 'string' ? Date.parse(rawTime) : NaN;
    let reason = (record.rtype ?? record.hd?.rtype) !== 33 ? 'invalid_bar_schema'
      : typeof raw !== 'string' || raw !== target.contract.providerRawSymbol ? 'raw_symbol_mismatch'
      : !Number.isFinite(time) || time % MINUTE || time < startTime || time + MINUTE > endTime || time + MINUTE > now ? 'invalid_or_incomplete_bar_time' : null;
    const values = ['open', 'high', 'low', 'close', 'volume'].map((k) => numeric(record[k]));
    const [open, high, low, close, volume] = values;
    if (!reason && (values.some((v) => v === null) || !Number.isSafeInteger(volume) || volume <= 0
      || high < Math.max(open, close, low) || low > Math.min(open, close))) reason = 'invalid_ohlcv';
    if (reason) { target.failures.add(reason); rejectRecord(reason, key, rawTime); return; }
    const bar = { time, open, high, low, close, volume };
    const prior = target.bars.get(time);
    if (prior) {
      duplicateRecords++;
      if (JSON.stringify(prior) !== JSON.stringify(bar)) { target.failures.add('conflicting_bar_revision'); rejectRecord('conflicting_bar_revision', key, rawTime); }
      return;
    }
    target.bars.set(time, bar); acceptedRecords++;
  }
  function finish({ observedNow = now } = {}) {
    if (!Number.isFinite(observedNow) || observedNow < now) throw new TypeError('Activity observation clock moved backwards.');
    const rows = [], rejectionReasons = {}, perRoot = new Map();
    const reasonsFor = (reasons) => { for (const reason of reasons) rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1; };
    for (const { contract, bars, failures } of byIdentity.values()) {
      const ordered = [...bars.values()].sort((a, b) => a.time - b.time), first = ordered[0], last = ordered.at(-1);
      const reasons = [...failures];
      if (Date.parse(contract.expiry) <= observedNow) reasons.push('contract_expired');
      if (!last) reasons.push('no_recent_trade_bars');
      else if (observedNow - (last.time + MINUTE) > maxBarAgeMs) reasons.push('stale_last_bar');
      if (ordered.length < 2 && last) reasons.push('insufficient_observed_bars');
      const rootKey = [dataset, contract.providerPublisherId, contract.providerExchange, contract.providerRoot].join(':');
      const row = { identity: contract.identity, providerRawSymbol: contract.providerRawSymbol, providerRoot: contract.providerRoot,
        providerPublisherId: contract.providerPublisherId, providerInstrumentId: contract.providerInstrumentId, providerExchange: contract.providerExchange,
        expiry: contract.expiry, rootKey, configuredPriority: contract.configuredPriority === true, status: reasons.length ? 'rejected' : 'screened', reasons,
        observedBars: ordered.length, expectedIntervalMinutes: (endTime - startTime) / MINUTE,
        missingTradeIntervals: (endTime - startTime) / MINUTE - ordered.length, latestBarClosedAt: last ? new Date(last.time + MINUTE).toISOString() : null,
        activityAsOf: new Date(observedNow).toISOString(), openInterest: null, tradeEligible: false, contractSpecVerified: false,
        strategyQualified: false, quoteQuality: 'no_executable_quote', classification: 'historical_activity_research' };
      rows.push(row);
      const group = perRoot.get(rootKey) || []; group.push(row); perRoot.set(rootKey, group);
      if (reasons.length) { reasonsFor(reasons); continue; }
      const volume = ordered.reduce((sum, b) => sum + b.volume, 0);
      if (!Number.isSafeInteger(volume)) { row.status = 'rejected'; row.reasons.push('volume_overflow'); reasonsFor(row.reasons); continue; }
      const high = Math.max(...ordered.map((b) => b.high)), low = Math.min(...ordered.map((b) => b.low));
      const consecutive = ordered.every((b, i) => !i || b.time - ordered[i - 1].time === MINUTE);
      const prior = ordered.at(-2), priorHigh = Math.max(...ordered.slice(0, -1).map((b) => b.high)), priorLow = Math.min(...ordered.slice(0, -1).map((b) => b.low));
      const movePct = pct(last.close - first.open, first.open), rangePct = pct(high - low, first.open);
      const recentVolumeRatio = consecutive && ordered.length >= 4 ? last.volume / ((volume - last.volume) / (ordered.length - 1)) : null;
      const previous = ordered.at(-3);
      const lastMove = consecutive ? pct(last.close - prior.close, prior.close) : null;
      const priorMove = previous && consecutive ? pct(prior.close - previous.close, previous.close) : null;
      Object.assign(row, { lastClose: last.close, totalContractsTraded: volume, movePct, absoluteMove: last.close - first.open, rangePct,
        recentVolumeRatio, volumeRatioBasis: recentVolumeRatio === null ? 'unavailable_sparse_or_short_window' : 'last_minute_vs_observed_prior_minutes',
        accelerationPctPoints: lastMove !== null && priorMove !== null ? lastMove - priorMove : null,
        brokeWindowHigh: last.close > priorHigh, brokeWindowLow: last.close < priorLow,
        direction: last.close > first.open ? 'up' : last.close < first.open ? 'down' : 'flat',
        // Work allocation only. Magnitudes/contract units differ across products; never interpret as calibrated confidence.
        activityRank: Math.log10(1 + volume) + Math.log1p(Math.abs(movePct ?? 0)) + Math.log1p(Math.abs(rangePct ?? 0))
          + Math.log2(1 + (recentVolumeRatio ?? 0)) });
    }
    const rootLeaders = [];
    for (const group of perRoot.values()) {
      const expiries = [...new Set(group.map((r) => r.expiry))].sort();
      for (const row of group) row.expiryOrderInDirectory = expiries.indexOf(row.expiry) + 1;
      const active = group.filter((r) => r.status === 'screened').sort((a, b) => b.totalContractsTraded - a.totalContractsTraded || b.activityRank - a.activityRank || a.identity.localeCompare(b.identity));
      for (const [index, row] of active.entries()) {
        row.observedWindowVolumeRank = index + 1;
        row.contractRole = row.expiryOrderInDirectory === 1 ? 'nearest_listed_expiry_reference' : 'deferred_expiry_reference';
        if (index < maxContractsPerRoot) rootLeaders.push(row);
        else { row.status = 'deferred'; row.reasons.push('per_root_candidate_budget'); reasonsFor(row.reasons); }
      }
    }
    rootLeaders.sort((a, b) => b.activityRank - a.activityRank || a.identity.localeCompare(b.identity));
    for (const [index, row] of rootLeaders.entries()) {
      row.overallActivityRank = index + 1;
      if (index < maxCandidates) row.status = 'candidate';
      else { row.status = 'deferred'; row.reasons.push('candidate_budget'); reasonsFor(row.reasons); }
    }
    const candidates = rows.filter((r) => r.status === 'candidate').sort((a, b) => a.overallActivityRank - b.overallActivityRank);
    return { rows, candidates, recordDispositions: unrecognized, diagnostics: { version: FUTURES_ACTIVITY_VERSION, status: 'screen_complete', dataset,
      start, end, observedAt: new Date(observedNow).toISOString(), directoryFingerprint: futuresActivityDirectoryFingerprint(directory),
      universe: rows.length, receivedRecords, acceptedRecords, duplicateRecords, barRecordRejections: recordRejections,
      observed: rows.filter((r) => r.observedBars > 0).length, unobserved: rows.filter((r) => !r.observedBars).length,
      dataQualified: rows.filter((r) => r.status !== 'rejected').length, rejected: rows.filter((r) => r.status === 'rejected').length,
      deferred: rows.filter((r) => r.status === 'deferred').length, candidates: candidates.length, directoryRoots: perRoot.size,
      rootsWithActivity: [...perRoot.values()].filter((g) => g.some((r) => r.observedBars > 0)).length,
      qualifiedActivityRoots: [...perRoot.values()].filter((g) => g.some((r) => r.totalContractsTraded > 0)).length,
      maxCandidates, maxContractsPerRoot, maxBarAgeMs, rejectionReasons, strategyQualified: 0, riskApproved: 0,
      note: 'Historical minute-bar research; sparse intervals are not filled. Recent volume rank is not active/front status, relative-volume seasonality, a recommendation or executable liquidity.' } };
  }
  return { add, finish };
}
