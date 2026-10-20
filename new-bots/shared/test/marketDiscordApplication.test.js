import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Events } from 'discord.js';
import { requireMarketDiscordConfig, readMarketDiscordConfig, discordInstallUrl, redactDiscordRuntimeText } from '../marketDiscordConfig.js';
import { buildMarketDiscordCommands, handleMarketDiscordCommand, formatMarketOperation } from '../marketDiscordOperations.js';
import { createMarketScanScheduler, acquireMarketApplicationLock } from '../marketBotRuntime.js';
import { validateMarketDiscordDestination, startMarketDiscordApplication } from '../marketDiscordApplication.js';
import { inspectDiscordApplications, assertIndependentDiscordIdentity } from '../discordApplicationAudit.js';
import { requestApplicationStop } from '../marketApplicationControl.js';

const env = { DISCORD_TOKEN: 'secret-test-token', DISCORD_CLIENT_ID: '111111111111111111', DISCORD_GUILD_ID: '222222222222222222',
  DISCORD_CHANNEL_ID: '333333333333333333', SCAN_INTERVAL_MINUTES: '5', OMNIMOD_EMERGENCY_STOP: 'true' };
const config = requireMarketDiscordConfig('forex', env);
test('Futures administrator directory counts stay separate from context and paper approvals', () => {
  const d = { source: 'databento', contractDiscovery: { status: 'cached', directory: { scope: 'dataset', dataset: 'GLBX.MDP3',
    streamComplete: true, uniqueIdentities: 800000, discoveredRoots: 200, unexpiredOutrights: 20000,
    currentlyUnexpiredReferences: 19998, outsideConfiguredPriorities: 18000, referenceAgeMs: 3600000, rejectionReasons: { option_contract: 770000 } } },
    contextUniverse: { universe: 36, observed: 0 }, activityDiscovery: { status: 'screen_complete', observed: 3000, dataQualified: 1000, deferred: 980, candidates: 20 },
    activityAnalysis: { status: 'evaluated', selected: 5, rejected: 10, deferred: 5, dataReady: 4, strategyQualified: 1,
      rejectionReasons: { reviewed_contract_metadata_missing: 10, deep_analysis_capacity: 5 } },
    dayTrade: { inputs: 0, strategyQualified: 0, riskApproved: 0, reservationsCreated: 0 } };
  const output = formatMarketOperation('scanstats', requireMarketDiscordConfig('futures', env), { latest: { diagnostics: d }, ageMs: 0 }, {}, env);
  assert.match(output, /"identities": 800000/);
  assert.match(output, /"unexpiredReferences": 19998/);
  assert.match(output, /"reservations": 0/);
  assert.match(output, /"candidates": 20/);
  assert.match(output, /"quotesExecutable": false/);
  assert.match(output, /"selected": 5/);
  assert.match(output, /"dataReady": 4/);
  assert.match(output, /reviewed_contract_metadata_missing/);
  assert.doesNotMatch(output, /truncated/);
});
async function temporary(run) {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-discord-app-'));
  try { return await run(dir); }
  finally { const root = resolve(tmpdir()) + sep; if (!resolve(dir).startsWith(root) || !dir.includes('omnimod-discord-app-')) throw Error('Unsafe test cleanup'); await rm(dir, { recursive: true, force: true }); }
}

test('each independent market has a command namespace and least-privilege installation URL', () => {
  const names = new Set();
  for (const bot of ['forex', 'futures', 'options', 'etfs-etps']) {
    const cfg = requireMarketDiscordConfig(bot, env); const [command] = buildMarketDiscordCommands(cfg);
    names.add(command.name); assert.equal(command.default_member_permissions, '32'); assert.equal(command.dm_permission, false);
    const url = new URL(discordInstallUrl(cfg)); assert.equal(url.hostname, 'discord.com'); assert.equal(url.searchParams.get('permissions'), '19456');
    assert.equal(url.searchParams.get('guild_id'), env.DISCORD_GUILD_ID); assert.equal(url.searchParams.get('scope'), 'bot applications.commands');
  }
  assert.equal(names.size, 4);
});

test('startup rejects missing destination, malformed IDs, unsafe intervals and live mode without secret text', () => {
  assert.throws(() => requireMarketDiscordConfig('forex', { ...env, DISCORD_CHANNEL_ID: '' }), /DISCORD_CHANNEL_ID/);
  for (const overrides of [{ DISCORD_CLIENT_ID: 'bad' }, { SCAN_INTERVAL_MINUTES: '0' }, { SCAN_TIMEOUT_MINUTES: 'invalid' }, { OMNIMOD_LIVE_TRADING_ENABLED: 'true' }]) {
    assert.equal(readMarketDiscordConfig('forex', { ...env, ...overrides }).ready, false);
  }
  assert.equal(redactDiscordRuntimeText(`Authorization Bot ${env.DISCORD_TOKEN}`, env).includes(env.DISCORD_TOKEN), false);
});

test('gateway destination validation rejects the wrong app, guild, channel type and missing permissions', async () => {
  const channel = { id: env.DISCORD_CHANNEL_ID, guildId: env.DISCORD_GUILD_ID, type: 0, permissionsFor: () => ({ has: () => true }) };
  const client = { application: { id: env.DISCORD_CLIENT_ID }, user: { bot: true }, channels: { fetch: async () => channel } };
  assert.equal(await validateMarketDiscordDestination(client, config), channel);
  client.application.id = '444444444444444444'; await assert.rejects(validateMarketDiscordDestination(client, config), /identity/); client.application.id = config.clientId;
  channel.guildId = '444444444444444444'; await assert.rejects(validateMarketDiscordDestination(client, config), /configured guild/); channel.guildId = config.guildId;
  channel.type = 1; await assert.rejects(validateMarketDiscordDestination(client, config), /text/); channel.type = 0;
  channel.permissionsFor = () => ({ has: () => false }); await assert.rejects(validateMarketDiscordDestination(client, config), /Send Messages/);
});

test('unauthorized command cannot read research or start a scan; authorized replies are ephemeral', async () => {
  let reads = 0, scans = 0; const replies = [];
  const interaction = { isChatInputCommand: () => true, commandName: 'forex', guildId: 'wrong', memberPermissions: { has: () => true },
    reply: async (row) => replies.push(row), deferReply: async (row) => replies.push(row), editReply: async (row) => replies.push(row), options: { getSubcommand: () => 'scan' } };
  const context = { config, env, getSnapshot: async () => { reads++; return {}; }, getRuntime: () => ({}), requestScan: () => { scans++; return { status: 'scan_started' }; } };
  await handleMarketDiscordCommand(interaction, context); assert.equal(reads, 0); assert.equal(scans, 0);
  interaction.guildId = config.guildId; interaction.memberPermissions.has = () => false;
  await handleMarketDiscordCommand(interaction, context); assert.equal(scans, 0);
  interaction.memberPermissions.has = () => true; await handleMarketDiscordCommand(interaction, context);
  assert.equal(scans, 1); assert.ok(replies.filter((r) => r.flags === 64).length >= 3);
  assert.match(formatMarketOperation('portfolio', config, { portfolio: null }, {}, env), /ledger_missing/);
});

test('administrator scan views distinguish missing data from a running application', () => {
  const readiness = { status: 'not_configured', automatedScanRan: false, label: 'Market data is not configured' };
  for (const diagnostics of [{ marketDataReadiness: readiness }, { funnel: { marketDataReadiness: readiness } }]) {
    for (const view of ['status', 'providers', 'lastscan', 'scanstats']) {
      const output = formatMarketOperation(view, config, { latest: { diagnostics }, ageMs: 0 }, { running: true }, env);
      assert.match(output, /"status": "not_configured"/);
      assert.match(output, /"automatedScanRan": false/);
    }
  }
  assert.match(formatMarketOperation('status', config, {}, {}, env), /"marketDataReadiness": null/);
});

test('Options administrator view keeps independent research and production counts visible without truncating the funnel', () => {
  const diagnostics = { source: 'manual', elapsedMs: 5000, marketDataReadiness: { status: 'research_only', automatedScanRan: true, label: 'Independent research' },
    funnel: { primarySignals: 0, providerReady: 0, strategyCandidates: 0, paperReservations: 0 },
    universe: { providerInstruments: 9000, eligibleInstruments: 6000, cheapScreen: { cheaplyScreened: 5000, shortlisted: 12 },
      optionPaperResearch: { status: 'research_observed', strategyCandidates: 1, shadowReservations: 0 },
      intradayResearch: { status: 'research_complete', feed: 'iex', selected: 12, attemptedSymbols: 12, evaluated: 12, dataReady: 4,
        technicalWatches: 1, conflicts: 1, dataRejected: 8, strategyRejected: 2, providerRejected: 0, deferred: 0, paperEligible: 0, elapsedMs: 4200,
        rejectionReasons: { missing_duplicate_or_unordered_minutes: 5, stale_future_or_unsynchronized_quote: 3, no_recent_opening_range_cross: 2 } } } };
  const output = formatMarketOperation('scanstats', requireMarketDiscordConfig('options', env),
    { latest: { capturedAt: '2026-10-02T14:00:00Z', diagnostics }, ageMs: 10 }, {}, env);
  assert.match(output, /"technicalWatches": 1/);
  assert.match(output, /"paperReservations": 0/);
  assert.match(output, /"paperEligible": 0/);
  assert.match(output, /"independentPaper"/);
  assert.match(output, /"approvedAlerts": false/);
  assert.match(output, /no_recent_opening_range_cross/);
  assert.doesNotMatch(output, /truncated/);
});

function schedulerFixture() {
  const children = [], timers = new Map(); let nextTimer = 0, now = 100_000;
  const scheduler = createMarketScanScheduler({ directory: 'fixture', entry: 'fixture.js', env, intervalMs: 60_000, timeoutMs: 120_000,
    clock: () => now, setTimer: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimer: (id) => timers.delete(id),
    spawnChild: (_node, _args, options) => {
      assert.equal(options.env.DISCORD_DELIVERY_MODE, 'bot'); assert.equal(options.windowsHide, true);
      const child = new EventEmitter(); child.pid = 123; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.signals = [];
      child.kill = (signal) => { child.signals.push(signal); return true; }; children.push(child); return child;
    } });
  return { scheduler, children, timers, advance: (ms) => { now += ms; } };
}

test('dedicated monitor scheduler passes its owner and remains independent of a busy discovery scanner', async () => {
  const children = [], states = [], timers = new Map(); let id = 0;
  const factory = (entry, args = []) => createMarketScanScheduler({ directory: 'fixture', entry, args, env,
    intervalMs: 60000, timeoutMs: 60000, onState: (state) => states.push(state),
    setTimer: (fn, delay) => { timers.set(++id, { fn, delay }); return id; }, clearTimer: (key) => timers.delete(key),
    spawnChild: (_node, passedArgs) => {
      const child = new EventEmitter(); child.pid = children.length + 1; child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; };
      children.push({ child, args: passedArgs }); return child;
    } });
  const scan = factory('scan.js'), monitor = factory('monitor.js', ['forex']);
  scan.start(); monitor.start();
  assert.deepEqual(children.map((row) => row.args), [['scan.js'], ['monitor.js', 'forex']]);
  assert.equal(scan.snapshot().state, 'scan-running');
  assert.equal(monitor.requestScan().status, 'scan_already_running');
  children[1].child.emit('close', 2);
  assert.equal(monitor.snapshot().lastScanExitCode, 2); assert.equal(scan.snapshot().state, 'scan-running');
  await Promise.all([scan.stop(), monitor.stop()]);
  assert.equal(states.at(-1).schedulerRunning, false);
});

test('monitor scheduling defaults off and rejects unbounded cadence', () => {
  assert.equal(readMarketDiscordConfig('forex', env).monitorIntervalMs, 0);
  assert.equal(readMarketDiscordConfig('forex', { ...env, PAPER_MONITOR_INTERVAL_SECONDS: '60' }).monitorIntervalMs, 60000);
  for (const value of ['59', '901', 'not-a-number']) assert.equal(readMarketDiscordConfig('forex', { ...env, PAPER_MONITOR_INTERVAL_SECONDS: value }).ready, false);
});

test('scheduler prevents overlap, recovers from spawn failure, and waits for child shutdown', async () => {
  const f = schedulerFixture(); f.scheduler.start();
  assert.equal(f.children.length, 1); assert.equal(f.scheduler.requestScan().status, 'scan_already_running');
  f.children[0].emit('error', Object.assign(new Error('failure'), { code: 'ENOENT' }));
  f.children[0].emit('close', -1); assert.equal(f.scheduler.snapshot().lastScanExitCode, 'spawn-error');
  const scheduled = [...f.timers.values()].find((t) => t.delay === 60_000); assert.ok(scheduled); scheduled.fn();
  assert.equal(f.children.length, 2);
  const stopped = f.scheduler.stop(); assert.deepEqual(f.children[1].signals, ['SIGTERM']);
  f.children[1].emit('close', null, 'SIGTERM'); await stopped;
  assert.equal(f.scheduler.snapshot().schedulerRunning, false); assert.equal(f.scheduler.requestScan().status, 'scheduler_not_running');
});

test('scheduler timeout cannot launch the next scan until the old child closes', async () => {
  const f = schedulerFixture(); f.scheduler.start();
  [...f.timers.values()].find((t) => t.delay === 120_000).fn();
  assert.deepEqual(f.children[0].signals, ['SIGTERM']); assert.equal(f.scheduler.requestScan().status, 'scan_already_running');
  [...f.timers.values()].find((t) => t.delay === 2000).fn(); assert.deepEqual(f.children[0].signals, ['SIGTERM', 'SIGKILL']);
  f.children[0].emit('close', null, 'SIGKILL'); await f.scheduler.stop();
});

test('application lock prevents duplicate workers and only its owner can release it', async () => temporary(async (dir) => {
  const release = await acquireMarketApplicationLock(dir, 'forex');
  await assert.rejects(acquireMarketApplicationLock(dir, 'forex'), /lock exists/); await release();
  const second = await acquireMarketApplicationLock(dir, 'forex'); await second();
}));

test('client construction and synchronous login failures release their locks without starting a scanner', async () => temporary(async (dir) => {
  const options = { bot: 'forex', directory: dir, env, installSignalHandlers: false, auditRootDir: dir };
  await assert.rejects(startMarketDiscordApplication({ ...options, clientFactory: () => { throw new Error('fixture construction failure'); } }), /construction failure/);
  let destroyed = 0;
  const client = new EventEmitter();
  client.login = () => { throw new Error(env.DISCORD_TOKEN); };
  client.destroy = () => { destroyed++; };
  await assert.rejects(startMarketDiscordApplication({ ...options, clientFactory: () => client }), /Discord login failed/);
  assert.equal(destroyed, 1);
  assert.equal(client.listenerCount(Events.ClientReady), 1); // Only the reconnect observer remains.
  assert.equal((await readdir(join(dir, 'data'))).includes('discord-application.lock'), false);
  const log = await readFile(join(dir, 'data', 'discord-application.log'), 'utf8');
  assert.equal(log.includes(env.DISCORD_TOKEN), false);
  assert.equal(log.includes('scan_finished'), false);
}));

test('six-app audit exposes missing configuration and duplicate owners without secret values', async () => temporary(async (base) => {
  const root = join(base, 'new-bots'); await mkdir(join(root, 'forex'), { recursive: true }); await mkdir(join(root, 'options'), { recursive: true });
  for (const bot of ['forex', 'options']) await writeFile(join(root, bot, '.env'), Object.entries(env).map(([key,value]) => `${key}=${value}`).join('\n'));
  const report = await inspectDiscordApplications({ rootDir: root });
  assert.deepEqual(report.duplicateApplications, [['forex', 'options']]); assert.deepEqual(report.duplicateTokens, [['forex', 'options']]);
  assert.equal(report.sixDistinctConfiguredIdentities, false); assert.equal(JSON.stringify(report).includes(env.DISCORD_TOKEN), false);
  assert.equal(report.applications.forex.gateway, 'not_checked_by_local_audit');
  await assert.rejects(assertIndependentDiscordIdentity('forex', env, { rootDir: root }), /separate application/);
}));

test('application mock connects, runs the unchanged child boundary, emits heartbeat and redacts child logs', async () => temporary(async (dir) => {
  await mkdir(join(dir, 'src')); await writeFile(join(dir, 'src', 'index.js'), `console.log(process.env.DISCORD_TOKEN); process.exitCode = 2;`);
  const client = new EventEmitter(); client.application = { id: config.clientId }; client.user = { bot: true };
  client.channels = { fetch: async () => ({ guildId: config.guildId, type: 0, permissionsFor: () => ({ has: () => true }) }) };
  client.login = async () => { queueMicrotask(() => client.emit(Events.ClientReady)); }; client.destroy = () => {}; client.isReady = () => true;
  const app = await startMarketDiscordApplication({ bot: 'forex', directory: dir, env, clientFactory: () => client, installSignalHandlers: false, auditRootDir: dir });
  try {
    for (let attempt = 0; attempt < 200 && app.scheduler.snapshot().lastScanExitCode === null; attempt++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(app.scheduler.snapshot().lastScanExitCode, 2);
    assert.equal((await requestApplicationStop({ directory: join(dir, 'data'), bot: 'forex', timeoutMs: 3000 })).status, 'owner_released');
    assert.equal(app.scheduler.snapshot().schedulerRunning, false);
  } finally { await app.stop(); }
  const log = await readFile(join(dir, 'data', 'discord-application.log'), 'utf8');
  assert.equal(log.includes(env.DISCORD_TOKEN), false); assert.match(log, /redacted/); assert.match(log, /application_ready/);
  const heartbeatName = (await readdir(join(dir, 'data'))).find((name) => name.includes('-heartbeat-'));
  const heartbeat = JSON.parse(await readFile(join(dir, 'data', heartbeatName), 'utf8'));
  assert.equal(heartbeat.role, 'discord-application'); assert.equal(heartbeat.lastScanExitCode, 2); assert.equal(heartbeat.processState, 'stopped');
}));

test('enabled application monitor completes a real idle child while discovery remains busy, and shuts both down', async () => temporary(async (dir) => {
  await mkdir(join(dir, 'src')); await writeFile(join(dir, 'src/index.js'), 'setInterval(() => {}, 1000);');
  const client = new EventEmitter(); client.application = { id: config.clientId }; client.user = { bot: true };
  client.channels = { fetch: async () => ({ guildId: config.guildId, type: 0, permissionsFor: () => ({ has: () => true }) }) };
  client.login = async () => { queueMicrotask(() => client.emit(Events.ClientReady)); }; client.destroy = () => {}; client.isReady = () => true;
  const app = await startMarketDiscordApplication({ bot: 'forex', directory: dir,
    env: { ...env, PAPER_MONITOR_INTERVAL_SECONDS: '60', TRADING_RISK_STATE_PATH: join(dir, 'ledger.json'),
      OMNIMOD_FORWARD_SHADOW_STATE_DIR: join(dir, 'shadow') },
    clientFactory: () => client, installSignalHandlers: false, auditRootDir: dir });
  try {
    for (let attempt = 0; attempt < 500 && app.monitor.snapshot().lastScanExitCode === null; attempt++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(app.monitor.snapshot().lastScanExitCode, 0);
    assert.equal(app.scheduler.snapshot().state, 'scan-running');
    const report = JSON.parse(await readFile(join(dir, 'data/paper-position-monitor.json'), 'utf8'));
    assert.equal(report.status, 'idle'); assert.equal(report.provider.requestAttempts, 0);
  } finally { await app.stop(); }
  assert.equal(app.monitor.snapshot().schedulerRunning, false); assert.equal(app.scheduler.snapshot().schedulerRunning, false);
  const heartbeatName = (await readdir(join(dir, 'data'))).find((name) => name.includes('-heartbeat-'));
  const heartbeat = JSON.parse(await readFile(join(dir, 'data', heartbeatName), 'utf8'));
  assert.equal(heartbeat.positionMonitor.enabled, true);
  assert.equal(heartbeat.positionMonitor.schedulerRunning, false);
  assert.equal(heartbeat.positionMonitor.lastScanExitCode, 0);
}));
