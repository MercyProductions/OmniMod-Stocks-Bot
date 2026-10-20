import { createHash } from 'node:crypto';
import { embedText, observedCount, safeLabel } from '../../new-bots/shared/discordPresentation.js';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits
} from 'discord.js';
import { getGuildSettings } from './guildSettings.js';
import { formatPercent, formatPrice } from './cryptoData.js';
import { formatDiagnosticCount } from '../../new-bots/shared/formatDiagnosticCount.js';

export const COLORS = Object.freeze({
  brand: 0x8b5cf6, green: 0x22c55e, red: 0xef4444, yellow: 0xf59e0b, blue: 0x3b82f6, warn: 0xf97316
});

export function isAdminInteraction(interaction) {
  return Boolean(interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild));
}

export function paperOutcomeLabel(status) {
  const labels = {
    tracking: 'tracking', target_tracking: 'target tracking',
    loss: 'stop reached', fell_short: 'target not reached', target_hit: 'first target reached',
    exceeded: 'final target exceeded', unverified: 'unverified after deadline'
  };
  return labels[status] || String(status || 'unknown').replaceAll('_', ' ');
}

export function probabilityEvidenceText(prediction) {
  const sampleSize = prediction.calibrationSampleSize !== null && prediction.calibrationSampleSize !== undefined
    && prediction.calibrationSampleSize !== '' && Number.isSafeInteger(Number(prediction.calibrationSampleSize)) && Number(prediction.calibrationSampleSize) >= 0
    ? Number(prediction.calibrationSampleSize) : null;
  const dayCount = prediction.calibrationDayCount !== null && prediction.calibrationDayCount !== undefined
    && prediction.calibrationDayCount !== '' && Number.isSafeInteger(Number(prediction.calibrationDayCount)) && Number(prediction.calibrationDayCount) >= 0
    ? Number(prediction.calibrationDayCount) : null;
  const sampleText = formatDiagnosticCount(sampleSize);
  const dayText = formatDiagnosticCount(dayCount);
  if (prediction.metaModelActive) {
    if (prediction.metaAbstained) {
      return `Withheld: the holdout-qualified model abstained${prediction.metaAbstainReason ? ` (${prediction.metaAbstainReason})` : ''}. ${sampleText} comparable outcomes; no probability is released.`;
    }
    const probability = Number(prediction.metaProbability);
    if (prediction.metaProbability !== null && prediction.metaProbability !== undefined && prediction.metaProbability !== ''
      && Number.isFinite(probability)) {
      return `Holdout-qualified model estimate: ${(probability * 100).toFixed(1)}% probability of after-cost paper R > 0. This is a model output, not an observed frequency; calibration sample n=${sampleText}, interval unavailable.`;
    }
  }
  const lowerBound = Number(prediction.confidenceLowerBound);
  if ((prediction.calibrationQualified === true || /empirically calibrated/i.test(String(prediction.confidenceMethod || '')))
    && sampleSize !== null && sampleSize >= 30 && prediction.confidenceLowerBound !== null && prediction.confidenceLowerBound !== undefined
    && prediction.confidenceLowerBound !== '' && Number.isFinite(lowerBound)
  ) {
    if (dayCount === null || dayCount < 5) return `Withheld: calibration needs at least 30 comparable outcomes across 5 distinct UTC days (currently n=${sampleText}, days=${dayText}).`;
    return `Historical score-band estimate of positive after-cost paper R: ${Number(prediction.confidence).toFixed(1)}% (approximate posterior lower bound ${lowerBound.toFixed(1)}%; ${sampleText} comparable outcomes across ${dayText} UTC days). It blends outcomes with a score-derived prior and has not passed an independent calibration test.`;
  }
  return `Withheld: the historical score-band estimate needs 30 comparable outcomes across 5 distinct UTC days (${sampleText}/30 outcomes, ${dayText}/5 days). The score-derived prior is not a measured probability.`;
}

export function trackerConfidenceText(prediction) {
  return probabilityEvidenceText(prediction);
}

function globalMarketContextText(context) {
  if (!context?.available) return 'Unavailable; BTC technical regime is the only broad-market regime input.';
  const money = (value) => Number.isFinite(Number(value)) ? `$${Number(value).toLocaleString('en-US', { maximumSignificantDigits: 5 })}` : 'n/a';
  const pct = (value) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}%` : 'n/a';
  const change = (value) => Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}%` : 'n/a';
  return `${context.status === 'fresh' ? 'Current' : 'STALE'} | Total crypto cap ${money(context.totalMarketCapUsd)} | BTC / ETH dominance ${pct(context.btcDominancePct)} / ${pct(context.ethDominancePct)} | cap 24h ${change(context.marketCapChange24hPct)} | volume 24h ${money(context.totalVolumeUsd)} (${change(context.volumeChange24hPct)}) | provider as of ${context.providerUpdatedAt || 'unknown'}${context.fetchError ? ` | refresh error ${String(context.fetchError).slice(0, 100)}` : ''}. Descriptive context only; not used by approval or score.`;
}

function escapeDiscordMarkdown(value) {
  return String(value || '').replace(/[\\`*_{}\[\]()#+\-.!|>~]/g, '\\$&');
}

async function fetchTextChannel(client, id, guildId) {
  if (!id) return null;
  const channel = await client.channels.fetch(id).catch(() => null);
  return channel?.isTextBased?.() && (!guildId || channel.guildId === guildId) ? channel : null;
}

export async function resolveResources(client, guildId) {
  const settings = await getGuildSettings(guildId);
  if (process.env.NODE_ENV === 'test' && process.env.OMNIMOD_TEST_SKIP_DISCORD_LOGIN === '1') {
    const testChannel = { guildId, isTextBased: () => true, send: async () => ({ id: 'test-message' }) };
    return { settings, signalsChannel: testChannel, resultsChannel: testChannel, logsChannel: testChannel, alertRole: null, adminRole: null };
  }
  const signalsChannel = await fetchTextChannel(client, settings.signalsChannelId, guildId);
  if (!signalsChannel) throw new Error('OmniMod Crypto is not configured here. An admin must run /crypto setup.');
  const guild = client.guilds.cache.get(guildId);
  return {
    settings, signalsChannel,
    resultsChannel: await fetchTextChannel(client, settings.resultsChannelId, guildId) || signalsChannel,
    logsChannel: await fetchTextChannel(client, settings.logsChannelId, guildId),
    alertRole: settings.alertRoleId && guild ? await guild.roles.fetch(settings.alertRoleId).catch(() => null) : null,
    adminRole: settings.adminRoleId && guild ? await guild.roles.fetch(settings.adminRoleId).catch(() => null) : null
  };
}

export async function logEvent(client, guildId, description, options = {}) {
  try {
    const resources = await resolveResources(client, guildId);
    if (!resources.logsChannel) return;
    const ping = Boolean(options.pingAdmin && resources.adminRole);
    await resources.logsChannel.send({
      content: ping ? `<@&${resources.adminRole.id}>` : '',
      embeds: [new EmbedBuilder()
        .setColor(options.color ?? COLORS.brand)
        .setTitle(options.title || 'OmniMod Crypto event')
        .setDescription(String(description).slice(0, 3900))
        .setTimestamp()],
      allowedMentions: ping ? { roles: [resources.adminRole.id] } : { parse: [] }
    });
  } catch {
    // Logging must never recurse into another failure.
  }
}

export function factorLines(prediction) {
  const f = prediction.factors || {};
  const fixed = (value, digits = 1, suffix = '') => value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
    ? 'n/a' : `${Number(value).toFixed(digits)}${suffix}`;
  const signedPct = (value, available) => !available || value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
    ? 'n/a' : `${Number(value) >= 0 ? '+' : ''}${(Number(value) * 100).toFixed(1)}%`;
  const validation = (ran, trades, expectancy) => {
    if (!ran) return 'unavailable';
    const n = Number(trades);
    if (!Number.isFinite(n) || n <= 0) return 'no completed sample (n=0)';
    return `${fixed(expectancy, 2)}R/${n}`;
  };
  const derivativesLabel = f.derivativesAvailable ? fixed(f.derivativesScore, 0)
    : f.derivativesConfigured ? `unavailable (${fixed(f.derivativesProviderCount, 0)} sources)` : 'disabled';
  return [
    `Snapshot ${fixed(f.snapshotModel)}`,
    `Technical ${f.technicalDataSufficient ? fixed(f.technicalScore) : 'n/a'}`,
    `RSI ${f.technicalDataSufficient ? fixed(f.rsi14) : 'n/a'}`,
    `ADX ${f.technicalDataSufficient ? fixed(f.adx14) : 'n/a'}`,
    `ATR ${f.technicalDataSufficient ? fixed(f.atrPct, 2, '%') : 'n/a'}`,
    `Volume z ${f.technicalDataSufficient ? fixed(f.volumeZScore, 2) : 'n/a'}`,
    `Book ${f.orderBookAvailable ? signedPct(f.orderBookImbalance, true) : 'n/a'}`,
    `Providers ${fixed(f.providerCount, 0)}`,
    `Dispersion ${Number(f.providerCount) >= 2 ? fixed(f.priceDispersionPct, 2, '%') : 'n/a (<2 sources)'}`,
    `BTC regime ${fixed(f.regimeScore, 0)}`,
    `Derivatives ${derivativesLabel} (${fixed(f.derivativesProviderCount, 0)} providers)`,
    `Funding PA ${f.derivativesAvailable ? fixed(f.fundingAnnualizedPct, 2, '%') : 'n/a'}`,
    `OI 5m ${f.derivativesAvailable && f.openInterestChangeAvailable ? fixed(f.openInterestChangePct, 2, '%') : 'n/a'}`,
    `Flow ${signedPct(f.orderFlowImbalance, f.orderFlowAvailable)}`,
    `Depth ${signedPct(f.depthImbalance, f.depthAvailable)}`,
    `Micro spread ${f.microstructureAvailable && f.spreadAvailable ? fixed(f.microSpreadBps, 1, 'bps') : 'n/a'}`,
    `Execution est. ${fixed(f.executionCostBps, 1, 'bps')} (${f.executionQuality || 'quality unknown'})`,
    `DVOL ${f.dvolAvailable ? `${fixed(f.dvol, 1)} (${fixed(f.dvolChangePct, 1)}%)` : 'n/a'}`,
    `Put skew ${f.putCallSkewAvailable ? fixed(f.putCallSkewIv, 1, ' IV') : 'n/a'}`,
    `Recent check ${validation(f.validationRan, f.validationTrades, f.validationExpectancyR)}`,
    `Overall check ${validation(f.overallValidationRan, f.validationOverallTrades, f.validationOverallExpectancyR)}`
  ].join(' | ');
}

export function predictionEmbed(prediction, options = {}) {
  const evidence = summarizeSignalEvidence(prediction);
  const newsSymbol = String(prediction.symbol || '').trim().toUpperCase();
  const formatNews = (item) => {
    const relatedEntities = Array.isArray(item.relatedEntities) ? item.relatedEntities : [];
    const exactRelatedTag = Boolean(newsSymbol) && relatedEntities.some((entity) => String(entity).trim().toUpperCase() === newsSymbol);
    const attribution = exactRelatedTag ? ` · Finnhub related tag matches ${escapeDiscordMarkdown(newsSymbol)}` : ' · no exact related-symbol tag';
    const topicTag = `rule tag ${escapeDiscordMarkdown(item.eventType || 'unknown')} / ${escapeDiscordMarkdown(item.direction || 'unknown')} / potential severity ${escapeDiscordMarkdown(item.potentialSeverity || 'unknown')}`;
    return `${escapeDiscordMarkdown(item.source || 'Finnhub feed — publisher unknown')} · ${topicTag} · ${escapeDiscordMarkdown(item.headline)}${item.url ? ` [article](${item.url})` : ' · no article URL'} · ${item.publishedAt}${attribution}`;
  };
  return new EmbedBuilder()
    .setColor(options.color ?? COLORS[prediction.outcomeColor] ?? COLORS.brand)
    .setTitle(options.title || `SHORT-TERM PAPER TRADE | ${prediction.symbol} | ${prediction.action}`)
    .setDescription(`${prediction.thesis}\n\n**${prediction.disclaimer}**`)
    .addFields(
      { name: 'Probability evidence', value: probabilityEvidenceText(prediction), inline: false },
      { name: 'Manually labeled catalysts (not model-validated)', value: Array.isArray(prediction.catalystContext) && prediction.catalystContext.length
        ? prediction.catalystContext.map((item) => `${item.eventType || 'other'} | ${item.direction || 'unknown'} | ${item.expectedness || 'unknown'} | ${item.horizon || 'unknown'} | ${item.impact || 'unknown'} | ${item.severity || 'unknown'}${item.reason ? ` — ${item.reason}` : ''}${item.sourceUrl ? ` [source](${item.sourceUrl})` : ''}`).join('\n').slice(0, 1024)
        : 'No active context supplied (manual event controls may be disabled); automated catalyst coverage is incomplete.', inline: false },
      ...(Array.isArray(prediction.recentMarketNews) ? [{ name: 'Recent crypto market headlines — unscored', value: prediction.recentMarketNews.length
        ? `${prediction.recentMarketNews.slice(0, 4).map(formatNews).join('\n')}\nKeyword tags are topic hints only; event truth, expectedness, price impact and direction beyond explicit incident classes are unverified. Finnhub related tags are provider metadata, not verified event impact. Headlines are unscored and do not affect the decision.`.slice(0, 1024)
        : 'No recent market headlines returned. This optional feed does not affect the trade decision.', inline: false }] : []),
      { name: 'Risk', value: prediction.risk, inline: true },
      { name: 'Decision', value: prediction.expectedProfitable ? 'Qualified paper entry' : 'No trade', inline: true },
      { name: 'Calibration', value: `${prediction.confidenceMethod || 'legacy score'} | ${prediction.calibrationStratum || 'global'} | ${Number(prediction.calibrationSampleSize || 0)} comparable outcomes across ${Number(prediction.calibrationDayCount || 0)} UTC days${prediction.metaModelActive ? ` | boosted ${(Number(prediction.metaProbability) * 100).toFixed(1)}%` : ' | learning model inactive'}`, inline: false },
      { name: 'Uncertainty gate', value: prediction.metaModelActive
        ? `${prediction.metaAbstained ? 'ABSTAIN' : 'cleared'} | OOD ${Number(prediction.metaOodScore || 0).toFixed(2)}σ | set {${(prediction.conformalPredictionSet || []).join(',')}}${prediction.metaAbstainReason ? ` | ${prediction.metaAbstainReason}` : ''}`
        : 'Inactive until sufficient clean holdout data exists.', inline: false },
      { name: 'Outcome distribution', value: prediction.outcomeModelActive
        ? `Target-before-stop ${(Number(prediction.targetBeforeStopProbability) * 100).toFixed(1)}% | time median ${Number(prediction.expectedTimeMinutes?.median || 0).toFixed(0)}m | return q10/median/q90 ${Number(prediction.predictedReturnR?.q10 || 0).toFixed(2)}/${Number(prediction.predictedReturnR?.median || 0).toFixed(2)}/${Number(prediction.predictedReturnR?.q90 || 0).toFixed(2)}R`
        : 'Inactive until time-to-event and excursion models pass repeated blind validation.', inline: false },
      { name: 'Modeled entry', value: `${formatPrice(prediction.entryLow)} - ${formatPrice(prediction.entryHigh)}`, inline: false },
      { name: 'Take profit 1', value: `${formatPrice(prediction.partialTargetPrice || prediction.targetPrice)} (bank 50%, then break-even stop)`, inline: true },
      { name: 'Final target', value: `${formatPrice(prediction.expectedEodPrice)} (${formatPercent(prediction.targetPct)})`, inline: true },
      { name: 'Hard invalidation', value: `${formatPrice(prediction.stopPrice)} (-${Number(prediction.stopPct).toFixed(2)}%)`, inline: true },
      { name: 'Reward / risk', value: `${Number(prediction.riskReward).toFixed(2)}R | modeled EV proxy ${Number(prediction.expectedValueR || 0).toFixed(2)}R`, inline: true },
      { name: 'Risk sizing', value: `Risk ≤${Number(prediction.accountRiskPct || 0).toFixed(2)}% of account; allocation ≤${Number(prediction.maxPositionPct || 0).toFixed(1)}%`, inline: true },
      { name: 'Data quality', value: `${prediction.dataQuality || 'Unknown'} | ${prediction.providerCount || 0} sources | ${prediction.marketRegime || 'unknown'} BTC regime`, inline: true },
      { name: 'Trade horizon', value: `${prediction.horizonLabel || 'Intraday'} (${Number(prediction.horizonMinutes || 0)}m)`, inline: true },
      { name: 'Tracking deadline', value: `<t:${Math.floor(new Date(prediction.deadlineAt).getTime() / 1000)}:R>`, inline: true },
      { name: 'Market motion', value: `1h ${formatPercent(prediction.change1h)} | 24h ${formatPercent(prediction.change24h)} | 7d ${formatPercent(prediction.change7d)}`, inline: false },
      { name: 'Global crypto context', value: globalMarketContextText(prediction.globalMarketContext).slice(0, 1024), inline: false },
      { name: 'Ensemble factors', value: factorLines(prediction).slice(0, 1024), inline: false },
      { name: 'Evidence at prediction time', value: `Supports: ${evidence.supporting.join('; ')}\nCautions: ${evidence.cautions.join('; ')}`.slice(0, 1024), inline: false },
      { name: 'Continuation guidance', value: prediction.continuation, inline: false }
    )
    .setFooter({ text: `Signal ${prediction.id} | Paper research only` })
    .setTimestamp(new Date(prediction.createdAt));
}

export async function findDailyDiscoveryMessage(client, guildId, dateKey) {
  try {
    const { signalsChannel } = await resolveResources(client, guildId);
    const titles = new Set([`SHORT-TERM CRYPTO SCAN | ${dateKey}`, `OmniMod Crypto Opening Scan | ${dateKey}`]);
    let before;
    for (let page = 0; page < 5; page += 1) {
      const messages = await signalsChannel.messages.fetch({ limit: 100, before });
      const found = messages.find((message) => message.author?.id === client.user?.id && message.embeds.some((embed) => titles.has(embed.title)));
      if (found) return found;
      if (messages.size < 100) break;
      before = messages.last()?.id;
    }
  } catch {
    return null;
  }
  return null;
}

export function formatOpeningInvestmentResearch(report) {
  if (!report || report.unavailable) return report?.unavailable || 'Daily investment research not collected for this opening.';
  const rows = (report.results || []).slice(0, 4);
  if (!rows.length) return 'No daily price-trend candidates passed data/liquidity checks.';
  const longWindow = [90, 180, 365].map((days) => {
    const row = report.forwardJournal?.longWindowShadow?.[days];
    return `${days}d ${row?.nonOverlappingWindows || 0} non-overlap resolved / ${row?.pending || 0} pending`;
  }).join('; ');
  return (`DAILY PRICE-TREND WATCHLIST (5/20/60 days; no fundamental/tokenomics underwriting)\n${rows.map((row) => {
    const longPrice = (row.longTermPerformance || []).filter((item) => [365, 540, 730].includes(item.days))
      .map((item) => `${item.days}d ${item.status === 'observed' ? `${Number(item.assetReturnPct).toFixed(1)}% / BTC ${Number(item.excessVsBenchmarkPct).toFixed(1)}pp` : item.status}`).join(', ');
    return `${row.symbol}: ${row.decision}${row.score == null ? '' : ` (research rank ${row.score}/100)`}${longPrice ? ` | historical price-only ${longPrice}` : ''}`;
  })
    .join('\n')}\nFrozen forward research: ${report.forwardJournal?.resolved || 0} resolved / ${report.forwardJournal?.pending || 0} pending.${report.forwardJournal?.cohortIncomplete ? ' INCOMPLETE cohort: overdue outcomes unresolved.' : ''}\nMonthly long-window shadow of the 200-day screen: ${longWindow}. Provider coverage varies; this is not fundamental/tokenomics underwriting. Use /crypto invest for BTC comparison and downside. Watchlist only; no buy instruction.`).slice(0, 1024);
}

export function summarizeSignalEvidence(prediction = {}) {
  const supporting = [];
  const cautions = [];
  const move1h = Number(prediction.change1h);
  const move24h = Number(prediction.change24h);
  const move7d = Number(prediction.change7d);
  const providers = Number(prediction.providerCount);
  const validationTrades = Number(prediction.factors?.validationTrades);
  const validationEdge = Number(prediction.factors?.validationExpectancyR);
  const calibrationN = Number(prediction.calibrationSampleSize);

  if (Number.isFinite(providers) && providers >= 2) supporting.push(`${providers} price sources (${prediction.providers || 'provider consensus'})`);
  if (Number.isFinite(move1h) && move1h > 0) supporting.push(`1h momentum ${move1h.toFixed(2)}%`);
  if (Number.isFinite(move24h) && move24h > 0) supporting.push(`24h momentum ${move24h.toFixed(2)}%`);
  if (Number.isFinite(move7d) && move7d > 0) supporting.push(`7d trend ${move7d.toFixed(2)}%`);
  if (Number.isFinite(validationTrades) && validationTrades >= 10 && Number.isFinite(validationEdge) && validationEdge > 0)
    supporting.push(`Recent rule validation ${validationEdge.toFixed(2)}R across ${validationTrades} trades`);
  if (!supporting.length) supporting.push('No additional positive market factor cleared the display thresholds.');

  const calibrationDays = Number(prediction.calibrationDayCount);
  if (!Number.isFinite(calibrationN) || calibrationN < 30 || !Number.isFinite(calibrationDays) || calibrationDays < 5) cautions.push(`Probability calibration evidence is limited (n=${Number.isFinite(calibrationN) ? calibrationN : 0}, distinct UTC days=${Number.isFinite(calibrationDays) ? calibrationDays : 0}; needs 30 outcomes across 5 days).`);
  if (prediction.dataQuality === 'Single-source only' || Number(prediction.providerCount) < 2) cautions.push('Price confirmation is single-source.');
  if (/risk.off|bear/i.test(String(prediction.marketRegime || ''))) cautions.push(`BTC regime is ${prediction.marketRegime}.`);
  if (/high|elevated/i.test(String(prediction.risk || ''))) cautions.push(`Modeled volatility risk is ${prediction.risk.toLowerCase()}.`);
  const dispersion = Number(prediction.priceDispersionPct);
  if (Number.isFinite(dispersion) && dispersion >= 0.5) cautions.push(`Venue price dispersion is ${dispersion.toFixed(2)}%.`);
  const executionCostBps = Number(prediction.factors?.executionCostBps);
  const executionQuality = String(prediction.factors?.executionQuality || 'unknown');
  if (executionQuality === 'unknown') cautions.push('Execution-cost estimate unavailable; fee, spread, and slippage coverage is not verified.');
  else if (Number.isFinite(executionCostBps) && executionCostBps >= 0)
    cautions.push(`Estimated round-trip execution cost is ${executionCostBps.toFixed(1)} bps (${executionQuality}); includes modeled fees and market impact, not observed fills.`);
  if (!prediction.metaModelActive) cautions.push('Validated learning model is inactive; confidence uses the rule/calibration path.');
  if (!prediction.outcomeModelActive) cautions.push('Blind-validated time-to-event model is inactive.');
  if (!cautions.length) cautions.push('No additional caution rule fired; this does not rule out unobserved risks.');
  return { supporting, cautions };
}

export function formatOpeningScanDecision(decision) {
  if (!decision) return 'Scan diagnostics unavailable for this opening.';
  const stages = `${decision.preliminary ?? 0} preliminary / ${decision.confirmed ?? 0} confirmed / ${decision.portfolioSelected ?? 0} within portfolio limits.`;
  if (decision.guardPaused) return `${stages}\nPaper signals paused: ${(decision.guardReasons || []).join(' ') || 'Risk guard limit reached.'} Research continues; the guard is re-evaluated on each scan.`.slice(0, 1024);
  if (decision.confirmed === 0) return `${stages}\nNo setup passed the multi-provider and walk-forward validation checks. Research continues.`;
  return `${stages}\nQualified paper calls still require the entry, risk, and daily slot checks. Research continues.`;
}

export function dayTradingWatchField(row) {
  const move = row.change1h == null ? 'unavailable' : formatPercent(row.change1h);
  return { name: safeLabel(`${row.symbol} · DEVELOPING LONG WATCH`), value: embedText(
    `Observed **${formatPrice(row.price)}** · 1h **${move}** · ${row.providerCount} price sources\n`
    + `Why on radar: short-term trend and technical screen passed. Strength **${Number(row.score).toFixed(0)}/100** is a rank, not profit odds.\n`
    + `Needs: ${row.reason}. Entry, stop and targets follow only in a separately approved paper setup.\n`
    + `Quote: ${safeLabel(row.source)} · <t:${Math.floor(Date.parse(row.observedAt) / 1000)}:t>`, 620) };
}

export function openingDayTradingEmbed(discovery) {
  const watches = (discovery.dayTradingWatches || []).slice(0, 5);
  return new EmbedBuilder().setColor(COLORS.brand).setTitle(`SHORT-TERM CRYPTO SCAN | ${discovery.dateKey}`)
    .setDescription(`**${observedCount(discovery.assetsScreened)} assets screened** · **${discovery.predictions.length} paper setups**.\nThese are the latest intraday highlights, not the complete universe. The bot keeps scanning its configured universe for changing conditions.`)
    .addFields(
      { name: 'Discovery → analysis → approval', value: embedText(formatOpeningScanDecision(discovery.scanDecision), 500) },
      { name: 'Day-trading focus', value: watches.length ? `Showing ${watches.length} developing watches from this scan. Technical strength does not establish a reliable probability of profit.` : 'No current watch met the confirmed technical and fresh-quote display checks. An empty shortlist does not mean the bot stopped scanning.' },
      ...watches.map(dayTradingWatchField),
      { name: 'Data coverage', value: embedText(discovery.source, 350) },
      { name: 'Separate research', value: 'Daily and longer-hold research is available through /crypto invest; those names are not this day-trading shortlist.' }
    ).setFooter({ text: `CRYPTO-SLATE:${discovery.dateKey} | Paper research · no order placed` })
    .setTimestamp(new Date(discovery.generatedAt));
}

export async function postOpeningSummary(client, guildId, discovery) {
  const resources = await resolveResources(client, guildId);
  const existing = await findDailyDiscoveryMessage(client, guildId, discovery.dateKey);
  if (existing) return { message: existing, created: false };
  const ping = Boolean(resources.alertRole && discovery.predictions.length);
  const message = await resources.signalsChannel.send({
    content: ping ? `<@&${resources.alertRole.id}>` : '', embeds: [openingDayTradingEmbed(discovery)],
    allowedMentions: ping ? { roles: [resources.alertRole.id] } : { parse: [] }
  });
  return { message, created: true };
}

export async function postDayTradingWatchUpdate(client, guildId, { dateKey, assetsScreened, watches, guardPaused }) {
  const resources = await resolveResources(client, guildId);
  const embed = new EmbedBuilder().setColor(COLORS.brand).setTitle(`OmniMod Crypto · Developing day-trade watches`)
    .setDescription(`${observedCount(assetsScreened)} assets screened. ${watches.length} new or improved watch highlights below; these are not the entire scan universe.\n${guardPaused ? 'New paper entries are paused by the risk guard. ' : ''}These watches are not approved entries or calibrated profit forecasts.`)
    .addFields(...watches.slice(0, 5).map(dayTradingWatchField))
    .setFooter({ text: `CRYPTO-WATCH:${dateKey} | Intraday research · no order placed` }).setTimestamp();
  return resources.signalsChannel.send({ embeds: [embed], allowedMentions: { parse: [] },
    nonce: createHash('sha256').update(`${guildId}:${dateKey}:${watches.map(row => row.noticeKey).sort().join(',')}`).digest('hex').slice(0, 24), enforceNonce: true });
}

export async function postNewPrediction(client, guildId, prediction) {
  const resources = await resolveResources(client, guildId);
  const message = await resources.signalsChannel.send({ embeds: [predictionEmbed(prediction)], allowedMentions: { parse: [] } });
  return { ...prediction, messageId: message.id, channelId: message.channelId };
}

export async function postOutcome(client, guildId, outcome) {
  const resources = await resolveResources(client, guildId);
  const p = outcome.prediction;
  const move = p.entryPrice > 0 ? (p.currentPrice / p.entryPrice - 1) * 100 : 0;
  const observation = outcome.type === 'unverified' ? 'First observed after deadline' : 'Closing observation';
  const observedAt = Number.isFinite(Date.parse(p.updatedAt)) ? ` <t:${Math.floor(Date.parse(p.updatedAt) / 1000)}:f>` : '';
  const paperResult = p.realizedR != null && Number.isFinite(Number(p.realizedR)) ? `${Number(p.realizedR) > 0 ? '+' : ''}${Number(p.realizedR).toFixed(2)}R` : 'ungraded; timing within the signal window is unverified';
  const embed = predictionEmbed(p, {
    color: COLORS[outcome.color] ?? COLORS.brand,
    title: `SHORT-TERM PAPER TRADE RESULT | ${p.symbol} | ${paperOutcomeLabel(outcome.type).toUpperCase()}`
  })
    .setDescription(`${outcome.description}\n\nEntry: **${formatPrice(p.entryPrice)}** | ${observation}${observedAt}: **${formatPrice(p.currentPrice)}** | Coin-price move from entry: **${formatPercent(move)}**\nGraded paper result: **${paperResult}**. The coin-price move alone is not the position's realized return.${outcome.type === 'unverified' ? '\nThis is not a verified within-window profit or target hit.' : ''}\n\nResearch and paper tracking only.`);

  if (p.messageId && p.channelId) {
    const channel = await client.channels.fetch(p.channelId).catch(() => null);
    const original = await channel?.messages.fetch(p.messageId).catch(() => null);
    if (original) return original.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  }
  return resources.resultsChannel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

export function alertButtons() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('crypto_alerts_in').setLabel('Enable crypto alerts').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('crypto_alerts_out').setLabel('Disable alerts').setStyle(ButtonStyle.Secondary)
  )];
}

export async function postRolePanel(client, guildId) {
  const resources = await resolveResources(client, guildId);
  return resources.signalsChannel.send({
    embeds: [new EmbedBuilder().setColor(COLORS.brand).setTitle('OmniMod Crypto alerts')
      .setDescription(resources.alertRole ? `Choose whether to receive <@&${resources.alertRole.id}> momentum notifications.` : 'No alert role is configured. Run /crypto setup again with an alert role.')],
    components: alertButtons(), allowedMentions: { parse: [] }
  });
}

export async function handleAlertButton(interaction) {
  const resources = await resolveResources(interaction.client, interaction.guildId);
  if (!resources.alertRole) return interaction.reply({ content: 'No Crypto Alerts role is configured.', ephemeral: true });
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const enable = interaction.customId === 'crypto_alerts_in';
  if (enable) await member.roles.add(resources.alertRole, 'OmniMod Crypto alert opt-in');
  else await member.roles.remove(resources.alertRole, 'OmniMod Crypto alert opt-out');
  return interaction.reply({ content: enable ? 'Crypto momentum alerts enabled.' : 'Crypto momentum alerts disabled.', ephemeral: true });
}
