import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readScanDiagnosticRows } from './scanDiagnosticsJournal.js';
import { readPaperRiskLedger } from './paperRisk.js';
import { resolvePaperLedgerPath } from './paperStatePath.js';
import { summarizeSharedPaperPortfolio } from './operatorReport.js';
import { readPrimaryResearchSignalsWithDiagnostics } from './signalResearch.js';
import { redactDiscordRuntimeText } from './marketDiscordConfig.js';
import { discordEmbedPayload } from './discordPresentation.js';

const views = { status: 'Application, scheduler and latest scan state', providers: 'Observed provider health from the latest scan',
  lastscan: 'Latest scan time, source and rejection reasons', scanstats: 'Latest discovery and strategy funnel counts',
  portfolio: 'This market paper portfolio and shared risk totals', signals: 'Recent delivered paper research signals',
  outcomes: 'Recent closed paper outcomes', stop: 'Read the emergency-stop state',
  scan: 'Request one non-overlapping paper research scan', 'delivery-test': 'Post a test to this bot’s configured channel' };

export function buildMarketDiscordCommands(config) {
  return [{ name: config.command, description: `${config.name} paper research operations`, default_member_permissions: '32',
    dm_permission: false, options: Object.entries(views).map(([name, description]) => ({ type: 1, name, description })) }];
}

export async function readMarketOperationalSnapshot({ bot, directory, env = process.env, now = Date.now() }) {
  const statePath = resolvePaperLedgerPath(env.TRADING_RISK_STATE_PATH || '');
  const [rows, ledgerExists, signals] = await Promise.all([
    readScanDiagnosticRows(join(directory, 'data', `${bot}-scan-diagnostics.jsonl`), { limit: 50 }),
    stat(statePath).then(() => true).catch((error) => { if (error.code === 'ENOENT') return false; throw error; }),
    readPrimaryResearchSignalsWithDiagnostics({ file: env.OMNIMOD_SIGNAL_RESEARCH_PATH, owners: [bot], now, maxAgeMs: 7 * 86_400_000 }),
  ]);
  const ledger = ledgerExists ? await readPaperRiskLedger({ statePath }) : null;
  const latest = rows.filter((row) => row.bot === bot).sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))[0] || null;
  return { latest, ageMs: latest ? Math.max(0, now - Date.parse(latest.capturedAt)) : null,
    portfolio: ledger ? summarizeSharedPaperPortfolio(ledger, { now }) : null,
    outcomes: (ledger?.orders || []).filter((row) => row.owner === bot && row.status === 'closed')
      .sort((a, b) => Date.parse(b.closedAt || '') - Date.parse(a.closedAt || '')).slice(0, 5)
      .map((row) => ({ instrument: row.instrumentKey, closedAt: row.closedAt, reason: row.exitReason,
        netPnlUsd: row.realizedPnlUsd ?? null, paperOnly: true })),
    signals: signals.records.slice(0, 5).map((row) => ({ symbol: row.symbol, direction: row.direction,
      at: row.observedAt, status: row.status, paperOnly: true })), signalJournal: signals.diagnostics.status };
}

export function formatMarketOperation(view, config, snapshot, runtime, env = process.env) {
  const d = snapshot.latest?.diagnostics || {}, nested = d.funnel || d;
  const readiness = d.marketDataReadiness ?? nested.marketDataReadiness;
  const scan = { capturedAt: snapshot.latest?.capturedAt ?? null, ageMs: snapshot.ageMs,
    source: d.source ?? nested.source ?? null, elapsedMs: d.elapsedMs ?? d.scanDurationMs ?? nested.elapsedMs ?? null,
    marketDataReadiness: readiness ? { status: readiness.status, automatedScanRan: readiness.automatedScanRan,
      label: readiness.label } : null };
  let value;
  switch (view) {
    case 'status': value = { application: config.name, ...runtime, latestScan: scan, liveOrders: 'not implemented' }; break;
    case 'providers': value = { ...scan, provider: d.provider ?? nested.provider ?? null, scope: 'last scan observations; missing is unknown' }; break;
    case 'lastscan': value = { ...scan, reasons: d.topRejectionReasons ?? nested.topRejectionReasons ?? null }; break;
    case 'scanstats': {
      value = { ...scan, universe: d.universe ?? nested.contextUniverse ?? null, funnel: nested.dayTrade ?? nested };
      if (config.bot === 'futures' && nested.contractDiscovery?.directory) {
        const c = nested.contractDiscovery, u = c.directory;
        value = { ...scan, directory: { status: c.status, scope: u.scope, dataset: u.dataset,
          streamComplete: u.streamComplete, identities: u.uniqueIdentities, roots: u.discoveredRoots,
          unexpiredReferences: u.currentlyUnexpiredReferences ?? u.unexpiredOutrights,
          outsidePriorities: u.outsideConfiguredPriorities, referenceAgeMs: u.referenceAgeMs ?? u.ageMs,
          topReasons: Object.fromEntries(Object.entries(u.rejectionReasons ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4)) },
        contextOnly: nested.contextUniverse, delivery: nested.discordDelivery,
        ...(nested.activityDiscovery ? { activity: { status: nested.activityDiscovery.status, observed: nested.activityDiscovery.observed,
          dataQualified: nested.activityDiscovery.dataQualified, deferred: nested.activityDiscovery.deferred, candidates: nested.activityDiscovery.candidates,
          quotesExecutable: false } } : {}),
        ...(nested.activityAnalysis ? { routing: { status: nested.activityAnalysis.status, selected: nested.activityAnalysis.selected,
          rejected: nested.activityAnalysis.rejected, deferred: nested.activityAnalysis.deferred,
          dataReady: nested.activityAnalysis.dataReady, strategyQualified: nested.activityAnalysis.strategyQualified,
          topReasons: Object.fromEntries(Object.entries(nested.activityAnalysis.rejectionReasons ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3)) } } : {}),
        dayStrategy: { inputs: nested.dayTrade?.inputs,
          qualified: nested.dayTrade?.strategyQualified, riskApproved: nested.dayTrade?.riskApproved,
          reservations: nested.dayTrade?.reservationsCreated } };
      }
      if (config.bot === 'options' && d.universe?.intradayResearch) {
        const u = d.universe, r = u.intradayResearch;
        // Full archives/diagnostics remain in the operator report. Keep both funnels visible within Discord's text budget.
        value = { ...scan, universe: { providerInstruments: u.providerInstruments ?? null, eligible: u.eligibleInstruments ?? null,
          cheaplyScreened: u.cheapScreen?.cheaplyScreened ?? null, shortlisted: u.cheapScreen?.shortlisted ?? null },
        production: { primarySignals: nested.primarySignals, providerReady: nested.providerReady,
          strategyCandidates: nested.strategyCandidates, paperReservations: nested.paperReservations },
        ...(u.optionPaperResearch ? { independentPaper: { status: u.optionPaperResearch.status,
          strategyCandidates: u.optionPaperResearch.strategyCandidates, shadowReservations: u.optionPaperResearch.shadowReservations,
          approvedAlerts: false } } : {}),
        independentResearch: { status: r.status, feed: r.feed, selected: r.selected, attempted: r.attemptedSymbols,
          evaluated: r.evaluated, dataReady: r.dataReady, technicalWatches: r.technicalWatches, conflicts: r.conflicts,
          rejected: { data: r.dataRejected, strategy: r.strategyRejected, provider: r.providerRejected, deferred: r.deferred },
          paperEligible: r.paperEligible, elapsedMs: r.elapsedMs,
          topReasons: Object.fromEntries(Object.entries(r.rejectionReasons ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3)) } };
      }
      break;
    }
    case 'portfolio': value = snapshot.portfolio ? { market: snapshot.portfolio.byBot?.[config.bot] ?? null,
      sharedOpenRiskUsd: snapshot.portfolio.openRiskUsd, sharedActiveOrders: snapshot.portfolio.activeOrders } : { status: 'ledger_missing', performance: null }; break;
    case 'signals': value = { journal: snapshot.signalJournal, records: snapshot.signals }; break;
    case 'outcomes': value = { ledger: snapshot.portfolio ? 'available' : 'missing', records: snapshot.outcomes }; break;
    case 'stop': value = { emergencyStopActive: env.OMNIMOD_EMERGENCY_STOP !== 'false', liveOrders: 'disabled by code',
      control: 'Read-only. Review local configuration to change paper stop state.' }; break;
    default: throw new Error('Unsupported operational view.');
  }
  const body = redactDiscordRuntimeText(JSON.stringify(value, null, 2), env).replace(/```/g, "'''");
  return `${config.name} · paper research\n\`\`\`json\n${body.slice(0, 1750)}${body.length > 1750 ? '\n… truncated; inspect local operator report for full detail' : ''}\n\`\`\``;
}

export async function handleMarketDiscordCommand(interaction, { config, getSnapshot, getRuntime, requestScan, deliveryTest, env = process.env }) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== config.command) return false;
  const authorized = interaction.guildId === config.guildId && interaction.memberPermissions?.has(32n);
  if (!authorized) { await interaction.reply({ embeds: discordEmbedPayload('This operation requires Manage Server in the configured server.').embeds, flags: 64, allowedMentions: { parse: [] } }); return true; }
  await interaction.deferReply({ flags: 64 });
  const view = interaction.options.getSubcommand();
  let content;
  if (view === 'scan') content = `${config.name}: ${(await requestScan()).status}.`;
  else if (view === 'delivery-test') {
    const result = await deliveryTest();
    content = result.posted ? 'Test delivered to the configured market channel.' : 'Test delivery was not confirmed.';
  } else content = formatMarketOperation(view, config, await getSnapshot(), getRuntime(), env);
  await interaction.editReply({ content: '', embeds: discordEmbedPayload(content, { title: `${config.name} · ${view}` }).embeds, allowedMentions: { parse: [] } });
  return true;
}
