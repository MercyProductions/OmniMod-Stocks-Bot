import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { processPaperQuote, readPaperRiskLedger } from './paperRisk.js';
import { getPaperLedgerWorkspaceRoot, resolvePaperLedgerPath, paperLedgerFingerprint } from './paperStatePath.js';
import { loadMarketPositionQuotes, positionMonitorLimits } from './marketPositionQuotes.js';
import { summarizePositionMarkCoverage } from './positionMarkDiagnostics.js';
import { paperMonitorProfile } from './paperMonitorConfig.js';
import { stockMarkSessionOpen } from './stockPositionQuotes.js';

const CLASSES = { crypto: ['crypto'], stocks: ['stock'], forex: ['forex'], futures: ['future'], options: ['option'], 'etfs-etps': ['etf', 'etp'] };
const ACTIVE = new Set(['reserved', 'filled', 'open']);
const numeric = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;

async function findLedgers(bot, env, shadowDirectories) {
  const sharedPath = resolvePaperLedgerPath(env.TRADING_RISK_STATE_PATH || '');
  const defaults = resolve(getPaperLedgerWorkspaceRoot(), 'shared/data/forward-shadow');
  const folders = new Set(shadowDirectories ?? [defaults, resolve(env.OMNIMOD_FORWARD_SHADOW_STATE_DIR || defaults)]);
  if (bot === 'options') for (const folder of [...folders]) folders.add(join(folder, 'options-independent'));
  const paths = new Set([sharedPath]), issues = [];
  for (const folder of folders) {
    let files;
    try { files = await readdir(folder, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') issues.push({ stage: 'shadow_directory', code: 'unreadable' }); continue; }
    for (const file of files) {
      if (!file.name.startsWith(`${bot}-`) || !/-[a-f0-9]{16}\.json$/.test(file.name)) continue;
      if (!file.isFile()) { issues.push({ stage: 'shadow_ledger', code: 'not_regular_file' }); continue; }
      paths.add(join(folder, file.name));
    }
  }
  return { paths: [...paths], sharedPath, issues };
}

/** One pass over owned persisted positions. Creates no candidates, reservations, experiments or Discord messages. */
export async function runPaperPositionMonitor({ bot, env = process.env, clock = Date.now,
  fetchMarks = loadMarketPositionQuotes, shadowDirectories } = {}) {
  if (!CLASSES[bot]) throw new TypeError('Unsupported paper position monitor owner.');
  if (env.OMNIMOD_LIVE_TRADING_ENABLED === 'true') throw new Error('Live trading is not implemented.');
  const started = clock(), limits = positionMonitorLimits(bot, env);
  const emergencyStop = env.OMNIMOD_EMERGENCY_STOP !== 'false';
  const inventory = await findLedgers(bot, env, shadowDirectories), issues = [...inventory.issues], books = [];
  const owns = (row) => row?.owner === bot && CLASSES[bot].includes(row.assetClass);
  const uniqueOwnedIds = (orders) => orders.filter((row) => owns(row) && ACTIVE.has(row.status)).every((row) =>
    typeof row.orderId === 'string' && row.orderId.length > 0 && orders.filter((other) => other.orderId === row.orderId).length === 1);
  const recovery = [];
  for (const statePath of inventory.paths) {
    try {
      const before = await readPaperRiskLedger({ statePath });
      if (!uniqueOwnedIds(before.orders)) { issues.push({ stage: 'ledger', code: 'ambiguous_owned_order_identity' }); continue; }
      for (const order of before.orders.filter((row) => owns(row) && row.status === 'reserved')) {
        const at = clock();
        if (emergencyStop || at >= Date.parse(order.entryExpiresAt) || at >= Date.parse(order.forceExitAt)) {
          const result = await processPaperQuote(order.orderId, null, { statePath, expectedOwner: bot, now: at, observationClock: clock, emergencyStop, ...limits });
          recovery.push({ status: result.status, reason: result.reason ?? null });
        }
      }
      const current = await readPaperRiskLedger({ statePath });
      if (!uniqueOwnedIds(current.orders)) { issues.push({ stage: 'ledger', code: 'ambiguous_owned_order_identity' }); continue; }
      books.push({ statePath, before, active: current.orders.filter((row) => owns(row) && ACTIVE.has(row.status)), attempts: [], marks: [] });
    } catch { issues.push({ stage: 'ledger', code: 'read_or_recovery_failed' }); }
  }
  // A UUID can be present in both an imported research ledger and production.
  // Remap per book, and route returned quotes only to that exact recorded owner.
  const routes = new Map();
  for (const [index, book] of books.entries()) for (const order of book.active) {
    const id = `${index}:${order.orderId}`;
    routes.set(id, { book, order });
  }
  const positions = [...routes].map(([orderId, { order }]) => ({ ...order, orderId }));
  const providerMetrics = [];
  let provider = { marks: [], diagnostics: { status: 'no_active_positions' } };
  if (positions.length) try { provider = await fetchMarks(bot, positions, { env, clock, providerMetrics }); }
  catch { provider = { marks: [], diagnostics: { status: 'provider_error' } }; }
  if (!Array.isArray(provider?.marks)) provider = { marks: [], diagnostics: { status: 'invalid_provider_result' } };
  const countById = new Map();
  for (const row of provider.marks) countById.set(row?.orderId, (countById.get(row?.orderId) || 0) + 1);
  let unexpectedMarks = 0, duplicateMarks = 0;
  for (const row of provider.marks) {
    const route = routes.get(row?.orderId);
    if (!route) { unexpectedMarks++; continue; }
    if (countById.get(row.orderId) !== 1) { duplicateMarks++; continue; }
    const mark = { ...row, orderId: route.order.orderId };
    route.book.marks.push(mark);
    try {
      const at = clock();
      const result = await processPaperQuote(mark.orderId, mark.quote, { statePath: route.book.statePath, expectedOwner: bot,
        now: at, observationClock: clock, ...limits, sessionOpen: bot === 'stocks' ? stockMarkSessionOpen(mark, at) : mark.sessionOpen === true, emergencyStop });
      route.book.attempts.push({ orderId: mark.orderId, status: result.status, reason: result.reason ?? null });
    } catch { route.book.attempts.push({ orderId: mark.orderId, status: 'error', reason: 'paper_quote_update_failed' }); }
  }
  const coverage = [];
  for (const book of books) try {
    const after = await readPaperRiskLedger({ statePath: book.statePath });
    coverage.push({ scope: book.statePath === inventory.sharedPath ? 'production' : 'shadow',
      ...summarizePositionMarkCoverage({ owner: bot, beforeOrders: book.before.orders, afterOrders: after.orders,
        availableMarks: book.marks, attempts: book.attempts, now: clock(), maxAgeMs: limits.maxOpenMarkAgeMs }) });
  } catch { issues.push({ stage: 'coverage', code: 'ledger_read_failed' }); }
  const attempts = books.flatMap((book) => book.attempts), reasons = {};
  for (const attempt of attempts) if (attempt.reason) reasons[attempt.reason] = (reasons[attempt.reason] || 0) + 1;
  const quotesMissing = positions.length - [...countById].filter(([id, count]) => routes.has(id) && count === 1).length;
  const degraded = issues.length || unexpectedMarks || duplicateMarks || quotesMissing || attempts.some((a) => ['blocked', 'error'].includes(a.status));
  const summary = provider.requestSummary;
  const aggregate = summary && ['attempts', 'failures', 'httpAttempts', 'websocketSessions'].every(k => Number.isSafeInteger(summary[k]) && summary[k] >= 0)
    && summary.failures <= summary.attempts && summary.attempts === summary.httpAttempts + summary.websocketSessions
    && Number.isFinite(summary.latencyMs) && summary.latencyMs >= 0 ? summary : null;
  return { schemaVersion: 1, bot, mode: 'owned_paper_positions_only', status: degraded ? 'degraded' : positions.length ? 'complete' : 'idle',
    quoteAdapterVersion: paperMonitorProfile(env, bot).version, monitoringProfile: paperMonitorProfile(env, bot),
    startedAt: new Date(started).toISOString(), completedAt: new Date(clock()).toISOString(), durationMs: Math.max(0, clock() - started),
    emergencyStop, liveTradingEnabled: false, ledgerFingerprint: paperLedgerFingerprint(inventory.sharedPath),
    counts: { ledgersRead: books.length, activeBeforeQuotes: positions.length, quotesMissing, unexpectedMarks, duplicateMarks,
      quotesProcessed: attempts.length, filled: attempts.filter((a) => a.status === 'filled').length,
      marked: attempts.filter((a) => a.status === 'open').length, closed: attempts.filter((a) => a.status === 'closed').length,
      rejected: attempts.filter((a) => ['blocked', 'error'].includes(a.status)).length,
      duplicateOrOutOfOrder: attempts.filter((a) => a.status === 'duplicate_or_out_of_order_quote').length,
      cancelled: recovery.filter((a) => a.status === 'cancelled').length + attempts.filter((a) => a.status === 'cancelled').length },
    provider: { status: String(provider.diagnostics?.status || 'unknown').slice(0, 80),
      rejectionReasons: Object.fromEntries(Object.entries(provider.diagnostics?.rejectionReasons || {})
        .filter(([key, count]) => /^[a-z_]{1,80}$/.test(key) && Number.isSafeInteger(count) && count > 0)),
      ...(bot === 'stocks' ? { feed: ['iex', 'sip'].includes(provider.diagnostics?.feed) ? provider.diagnostics.feed : null,
        quoteCoverage: ['single_venue', 'consolidated'].includes(provider.diagnostics?.quoteCoverage) ? provider.diagnostics.quoteCoverage : null } : {}),
      requestAttempts: aggregate?.attempts ?? providerMetrics.filter((m) => m.requestAttempted !== false && numeric(m.status) !== null).length,
      budgetDeferrals: providerMetrics.filter((m) => m.requestAttempted === false).length,
      failures: aggregate?.failures ?? providerMetrics.filter((m) => m.requestAttempted !== false && numeric(m.status) !== null && (m.status === 0 || m.status >= 400)).length,
      latencyMs: aggregate?.latencyMs ?? providerMetrics.reduce((sum, m) => sum + (m.requestAttempted === false ? 0 : numeric(m.latencyMs) ?? 0), 0),
      ...(aggregate ? { httpAttempts: aggregate.httpAttempts, websocketSessions: aggregate.websocketSessions } : {}),
      counterBasis: bot === 'crypto' ? 'Observed HTTP attempts plus bounded Kraken WebSocket sessions; identity/product metadata included; no market discovery/history.'
        : 'Adapter HTTP attempts or Databento live collection sessions; no discovery/history requests.' },
    rejectionReasons: reasons, issues, coverage,
    limitation: 'Sampled executable quotes; polling does not prove intrapoll barrier order, queue priority, or actual market fills.' };
}

export async function savePaperPositionMonitorReport(report, directory) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'paper-position-monitor.json'), temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await rename(temp, file);
  return file;
}

export async function readPaperPositionMonitorReport(bot, directory, now = Date.now()) {
  try {
    const row = JSON.parse(await readFile(join(directory, 'paper-position-monitor.json'), 'utf8'));
    const at = Date.parse(row.completedAt);
    if (row.schemaVersion !== 1 || row.bot !== bot || !Number.isFinite(at) || at > now + 5000) return { status: 'invalid' };
    return { ...row, reportAgeMs: Math.max(0, now - at), freshness: now - at > 5 * 60000 ? 'stale' : 'fresh' };
  } catch (error) { return { status: error.code === 'ENOENT' ? 'not_run' : 'unreadable' }; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Pass one market owner.');
    const report = await runPaperPositionMonitor({ bot: process.argv[2] });
    await savePaperPositionMonitorReport(report, resolve(process.cwd(), 'data'));
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'degraded') process.exitCode = 2;
  } catch { console.error('Paper position monitor failed; inspect configuration and ledger integrity.'); process.exitCode = 1; }
}
