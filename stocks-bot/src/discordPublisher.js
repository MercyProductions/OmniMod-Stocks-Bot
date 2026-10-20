import { embedText, observedCount, safeLabel } from '../../new-bots/shared/discordPresentation.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { formatPercent, formatPrice } from './stocksData.js';
import { getGuildSettings } from './guildSettings.js';

export const COLORS = Object.freeze({ purple: 0x8b5cf6, green: 0x22c55e, blue: 0x3b82f6, yellow: 0xeab308, red: 0xef4444, orange: 0xf97316, gray: 0x64748b });

export function isAdminInteraction(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

export async function resolveResources(client, guildId) {
  const settings = await getGuildSettings(guildId);
  const guild = await client.guilds.fetch(guildId);
  const channel = async (id) => id ? guild.channels.fetch(id).catch(() => null) : null;
  return { guild, settings, signals: await channel(settings.signalsChannelId), results: await channel(settings.resultsChannelId), logs: await channel(settings.logsChannelId) };
}

export async function logEvent(client, guildId, description, options = {}) {
  const { logs, settings } = await resolveResources(client, guildId);
  if (!logs?.isTextBased()) return null;
  const embed = new EmbedBuilder().setColor(options.color || COLORS.purple).setTitle(options.title || 'OmniMod Stocks event')
    .setDescription(String(description).slice(0, 4000)).setTimestamp();
  const content = options.pingAdmin && settings.adminRoleId ? `<@&${settings.adminRoleId}>` : undefined;
  return logs.send({ content, embeds: [embed], allowedMentions: { roles: content ? [settings.adminRoleId] : [] } }).catch(() => null);
}

function factorLine(prediction) {
  const f = prediction.factors || {};
  const sector = f.sectorDataStatus === 'available'
    ? `Sector proxy ${Number(f.sector || 0).toFixed(0)} (7%)`
    : 'Sector proxy unavailable; neutral factor (7%)';
  return `Trend ${Number(f.trend || 0).toFixed(0)} (20%) | Momentum ${Number(f.momentum || 0).toFixed(0)} (15%) | Volume ${Number(f.volume || 0).toFixed(0)} (12%)\nBreakout ${Number(f.breakout || 0).toFixed(0)} (12%) | VWAP ${Number(f.vwap || 0).toFixed(0)} (10%) | Relative strength ${Number(f.relativeStrength || 0).toFixed(0)} (12%)\n${sector} | Regime ${Number(f.regime || 0).toFixed(0)} (8%) | Providers ${Number(f.provider || 0).toFixed(0)} (4%)`;
}

export function formatPointInTimeEventRisk(prediction = {}) {
  const sec = prediction.recentSecForm
    ? `SEC ${prediction.recentSecForm} ${prediction.recentSecFiledAt || ''}`.trim()
    : prediction.secDataStatus === 'available' ? 'SEC checked; no recent filing' : `SEC coverage ${prediction.secDataStatus || 'unknown'}`;
  const actions = prediction.corporateActionType
    ? `${prediction.corporateActionType} ${prediction.corporateActionDate || ''}`.trim()
    : prediction.corporateActionDataStatus === 'available' ? 'Corporate actions checked; none nearby' : `Corporate-action coverage ${prediction.corporateActionDataStatus || 'unknown'}`;
  const components = prediction.macroComponentsAvailable !== null && prediction.macroComponentsAvailable !== undefined
    && Number.isInteger(Number(prediction.macroComponentsAvailable))
    ? `, ${prediction.macroComponentsAvailable}/3 components` : '';
  const macro = prediction.macroStress !== null && prediction.macroStress !== undefined && prediction.macroStress !== ''
    && Number.isFinite(Number(prediction.macroStress)) && prediction.macroDataStatus !== 'unavailable'
    ? `Macro stress ${Number(prediction.macroStress).toFixed(0)}/100 (${prediction.macroDataStatus || 'coverage unknown'}${components})`
    : `Macro stress unavailable (${prediction.macroDataStatus || 'coverage unknown'}${components})`;
  const manual = (prediction.manualCatalysts || []).slice(0, 2).map((row) =>
    `${row.eventType || 'other'} | operator-tagged direction ${row.direction || 'unknown'} | ${row.expectedness || 'unknown'} | impact ${row.impact || 'unknown'} | ${row.horizon || 'unknown'}: ${String(row.reason || '').slice(0, 90)}${row.sourceUrl ? ` (${String(row.sourceUrl).slice(0, 120)})` : ' (source not supplied)'}`);
  const newsStatus = prediction.recentNewsStatus || 'unknown';
  const news = (prediction.recentNews || []).slice(0, 2).map((row) =>
    `${row.publisher || row.provider || 'News'} ${row.activityAt || row.createdAt || ''} [topic ${row.eventType || 'unknown'} / ${row.direction || 'unknown'} / possible severity ${row.potentialSeverity || 'unknown'}]: ${String(row.headline || '').slice(0, 150)}${row.sourceUrl ? ` (${row.sourceUrl.slice(0, 100)})` : ''}`);
  return `${sec} | ${actions} | ${macro}\nRecent headlines (${newsStatus}; context only, unscored): ${news.length ? `${news.join(' | ')}. Rule tags are topic hints only; story truth, expectedness, horizon and price impact are unknown.` : newsStatus === 'available' ? 'No recent items returned' : 'Unavailable or not enabled'}`
    + (manual.length ? `\nOperator catalyst tags (unverified; not sentiment analysis; no score/gate effect): ${manual.join(' | ')}` : '');
}

export function summarizeSignalEvidence(prediction = {}) {
  const supporting = [];
  const cautions = [];
  const relVol = Number(prediction.relativeVolume);
  const relStrength = Number(prediction.relativeStrengthDay);
  const vwapDistance = Number(prediction.vwapDistancePct);
  const confirmations = Number(prediction.confirmationCount);
  const required = Number(prediction.confirmationRequired);
  const rsi = Number(prediction.rsi14);
  const atr = Number(prediction.atrPercent);
  const dataQuality = prediction.dataQuality === null || prediction.dataQuality === undefined || prediction.dataQuality === '' ? NaN : Number(prediction.dataQuality);
  const daysToEarnings = prediction.daysToEarnings === null || prediction.daysToEarnings === undefined || prediction.daysToEarnings === '' ? NaN : Number(prediction.daysToEarnings);

  if (/confirmed|constructive/i.test(String(prediction.trend || ''))) supporting.push(String(prediction.trend));
  if (Number.isFinite(relVol) && relVol >= 1.5) supporting.push(`Relative volume ${relVol.toFixed(2)}x`);
  if (Number.isFinite(relStrength) && relStrength > 0) supporting.push(`Outperforming SPY by ${relStrength.toFixed(2)}% today`);
  if (Number.isFinite(vwapDistance) && vwapDistance > 0) supporting.push(`${vwapDistance.toFixed(2)}% above VWAP`);
  if (Number.isFinite(confirmations) && Number.isFinite(required) && confirmations > 1)
    supporting.push(`${confirmations}/${required || confirmations} consecutive confirmation scans`);
  if (!supporting.length) supporting.push('No additional supporting factor cleared the display thresholds.');

  if (!prediction.calibration?.calibrated) cautions.push('Outcome probability is not calibrated for this score band yet.');
  if (['sideways', 'risk-off trend'].includes(String(prediction.marketRegime || '').toLowerCase())) cautions.push(`Market regime is ${prediction.marketRegime}.`);
  if (Number.isFinite(relStrength) && relStrength < 0) cautions.push(`Underperforming SPY by ${Math.abs(relStrength).toFixed(2)}% today.`);
  if (Number.isFinite(rsi) && rsi > 72.5) cautions.push(`RSI ${rsi.toFixed(1)} is extended.`);
  if (Number.isFinite(atr) && atr >= 5) cautions.push(`ATR ${atr.toFixed(2)}% indicates high volatility.`);
  if (Number.isFinite(dataQuality) && dataQuality < 70) cautions.push(`Data quality is ${dataQuality.toFixed(0)}/100.`);
  if (prediction.freshness === 'stale' || prediction.delayed) cautions.push(`${prediction.freshness || 'Provider'} data may be delayed or stale.`);
  if (Number(prediction.liveProviderQuoteCount) > 1 && Number(prediction.providerAgreement) < 90)
    cautions.push(`Live providers agree only ${Number(prediction.providerAgreement).toFixed(0)}%.`);
  if (Number.isFinite(daysToEarnings) && daysToEarnings >= 0 && daysToEarnings <= 3) cautions.push(`Earnings are ${daysToEarnings === 0 ? 'today' : `in ${daysToEarnings} day(s)`}.`);
  if (Number(prediction.macroStress) >= 70) cautions.push(`Macro stress is elevated (${Number(prediction.macroStress).toFixed(0)}/100).`);
  for (const [label, status] of [['SEC filings', prediction.secDataStatus], ['corporate actions', prediction.corporateActionDataStatus]]) {
    if (status && status !== 'available') cautions.push(`${label[0].toUpperCase()}${label.slice(1)} context is ${status.replaceAll('_', ' ')}; absence of an event is not confirmed.`);
  }
  if (prediction.macroDataStatus === 'partial') cautions.push(`Macro context is partial (${prediction.macroComponentsAvailable ?? '?'} of 3 components); its stress score is incomplete.`);
  else if (prediction.macroDataStatus && !['available'].includes(prediction.macroDataStatus))
    cautions.push(`Macro context is ${prediction.macroDataStatus.replaceAll('_', ' ')}; the score does not reflect a complete macro screen.`);
  if (prediction.manualCatalysts?.length) cautions.push('Operator-entered catalyst context is unverified; confirm its source, timing, and relevance to this short-term setup.');
  if (!prediction.executionEvidence || prediction.executionEvidence.stressedExpectedR == null)
    cautions.push('Execution-stressed expectancy is unavailable.');
  if (prediction.executionFeeAssumptionConfigured === false)
    cautions.push('Broker fee assumption is missing; net paper results may overstate returns.');
  if (!cautions.length) cautions.push('No additional caution rule fired; this does not rule out unobserved risks.');
  return { supporting, cautions };
}

export function predictionEmbed(prediction, options = {}) {
  const color = COLORS[options.color || prediction.outcomeColor] || COLORS.purple;
  const freshness = prediction.delayed ? `${prediction.freshness || 'delayed'} data` : (prediction.freshness || 'provider data');
  const evidence = summarizeSignalEvidence(prediction);
  return new EmbedBuilder().setColor(color)
    .setTitle(options.title || `SHORT-TERM PAPER TRADE | ${prediction.symbol} | ${prediction.horizonLabel}`)
    .setDescription(options.description || prediction.thesis)
    .addFields(
      { name: 'Model', value: `Score **${Number(prediction.score).toFixed(1)}/100** | Quality **${prediction.signalQuality || 'n/a'}** | Data **${Number(prediction.dataQuality || 0).toFixed(0)}/100**\n${prediction.action}`, inline: false },
      { name: 'Ensemble decision', value: prediction.ensemble?.active
        ? `**${prediction.ensemble.decision}** | estimated profitable probability ${Number(prediction.ensemble.probability || 0).toFixed(1)}% (${Number(prediction.ensemble.probabilityLow || 0).toFixed(1)}-${Number(prediction.ensemble.probabilityHigh || 0).toFixed(1)}%) | expected ${Number(prediction.ensemble.expectedR || 0).toFixed(2)}R\n${prediction.ensemble.source === 'research_v4' ? `v4 ${prediction.ensemble.expertId || 'expert'} / ${prediction.ensemble.algorithm || 'validated model'} | ` : ''}${prediction.ensemble.reason}`
        : `**RULE ONLY** | No validated champion is installed yet. Deterministic screens keep collecting research data${String(prediction.action || '').includes('DO NOT OPEN') ? '; this setup is not approved for an alert/trade' : '; this server explicitly allows rule-only alerts'}.`, inline: false },
      { name: 'Calibration', value: prediction.calibration?.calibrated
        ? `Historical target-hit estimate **${Number(prediction.calibration.probability).toFixed(1)}%** (approx. 90% interval ${Number(prediction.calibration.low).toFixed(1)}-${Number(prediction.calibration.high).toFixed(1)}%; score band ${prediction.calibration.scoreBand || 'unknown'}; n=${prediction.calibration.sampleSize} across ${prediction.calibration.dayCount || 0} outcome days). Scope: ${prediction.calibration.scope || 'same short-term horizon and market regime'}; not independently calibrated.`
        : `No stable target-hit probability yet (${prediction.calibration?.sampleSize || 0}/20 outcomes across ${prediction.calibration?.dayCount || 0}/5 outcome days for this score band, horizon, and regime). ${prediction.calibration?.marketRegime || 'unknown'} regime; sparse estimates are withheld.`, inline: false },
      { name: 'Conditional paper buy zone', value: `${formatPrice(prediction.entryLow)} - ${formatPrice(prediction.entryHigh)}\nDo not chase above ${formatPrice(prediction.doNotChasePrice)}`, inline: true },
      { name: 'Invalidation / stop', value: `${formatPrice(prediction.stopPrice)} (${formatPercent(-prediction.stopPct)})`, inline: true },
      { name: 'Target 1', value: `${formatPrice(prediction.targetPrice)} (${formatPercent(prediction.targetPct)})`, inline: true },
      { name: 'Target 2', value: `${formatPrice(prediction.exceedPrice)} (${formatPercent(prediction.exceedPct)})`, inline: true },
      { name: 'Risk / reward', value: `${Number(prediction.riskReward).toFixed(2)}R | ${prediction.risk || 'n/a'} volatility\nPaper risk multiplier ${Number(prediction.paperRiskMultiplier ?? 1).toFixed(2)}x`, inline: true },
      { name: 'Modeled execution costs', value: `Slippage ${Number(prediction.slippageBps || 0).toFixed(1)} bps/side | fees ${prediction.executionFeeAssumptionConfigured ? `${Number(prediction.commissionBpsPerSide || 0).toFixed(2)} bps/side${prediction.roundTripFeesPerShare !== null && prediction.roundTripFeesPerShare !== undefined ? ` ($${Number(prediction.roundTripFeesPerShare).toFixed(4)}/share round trip)` : ''}` : 'not configured'}`, inline: true },
      { name: 'Execution evidence', value: prediction.executionEvidence?.stressedExpectedR !== null && prediction.executionEvidence?.stressedExpectedR !== undefined
        ? `Conservative edge after extra spread/cost reserve: ${prediction.executionEvidence.stressedExpectedR.toFixed(2)}R | reserve ${prediction.executionEvidence.costReserveBps.toFixed(1)} bps. ${prediction.selectionEvidence}`
        : 'Expected return after execution stress is unknown. This research snapshot is not portfolio-approved.', inline: false },
      { name: 'Window', value: `${prediction.horizonLabel}\nEnds <t:${Math.floor(new Date(prediction.deadlineAt).getTime() / 1000)}:R>`, inline: true },
      { name: 'Buy condition', value: prediction.buyCondition || 'Use only while the published setup remains valid.', inline: false },
      { name: 'Sell / monitoring plan', value: `${prediction.sellPlan || prediction.continuation}\nMonitor about every ${prediction.monitoringMinutes || 5} minutes.`, inline: false },
      { name: 'Price action', value: `1h ${formatPercent(prediction.change1h)} | Day ${formatPercent(prediction.changeDay)} | 5d ${formatPercent(prediction.change5d)}\nRelative volume ${Number(prediction.relativeVolume).toFixed(2)}x | RSI ${Number(prediction.rsi14).toFixed(1)} | ATR ${Number(prediction.atrPercent).toFixed(2)}% | VWAP ${formatPercent(prediction.vwapDistancePct)}`, inline: false },
      { name: 'Auralith v4 factors', value: factorLine(prediction), inline: false },
      { name: 'Context', value: `${prediction.sector || 'SPY'} ${formatPercent(prediction.sectorChange)} | vs SPY ${formatPercent(prediction.relativeStrengthDay)} | Market ${prediction.marketRegime || 'unknown'} (${formatPercent(prediction.marketMove)}; ${Number(prediction.marketBreadth || 0).toFixed(0)}% breadth)`, inline: false },
      { name: 'Point-in-time event risk', value: formatPointInTimeEventRisk(prediction), inline: false },
      { name: 'Evidence at prediction time', value: `Supports: ${evidence.supporting.join('; ')}\nCautions: ${evidence.cautions.join('; ')}`.slice(0, 1024), inline: false },
      { name: 'Data provenance', value: `${prediction.provider || 'market provider'}${prediction.crossCheckProvider ? ` + ${prediction.crossCheckProvider}${Number(prediction.liveProviderQuoteCount || 1) > 1 ? ` (${Number(prediction.providerAgreement).toFixed(0)}% live-quote agreement; ${Number(prediction.providerDispersionBps || 0).toFixed(0)} bps max dispersion)` : ' (reference cross-check)'}` : ''} | ${freshness}${prediction.microstructureProvider ? ` | spread ${Number(prediction.spreadBps || 0).toFixed(1)} bps via ${prediction.microstructureProvider}` : ''}${prediction.nextEarningsDate ? ` | Earnings ${prediction.nextEarningsDate}` : ''}`, inline: false }
    )
    .setFooter({ text: prediction.disclaimer || 'Research and paper tracking only. No trade is placed.' }).setTimestamp(new Date(prediction.updatedAt || prediction.createdAt));
}

export async function findDailyDiscoveryMessage(client, guildId, dateKey) {
  const { signals } = await resolveResources(client, guildId);
  if (!signals?.isTextBased()) return null;
  const messages = await signals.messages.fetch({ limit: 100 }).catch(() => null);
  return messages?.find((message) => message.author.id === client.user.id && message.embeds.some((embed) => embed.footer?.text?.includes(`STOCK-SLATE:${dateKey}`))) || null;
}

export async function postWeeklyStatus(client, guildId, status) {
  const { signals } = await resolveResources(client, guildId);
  if (!signals?.isTextBased()) throw new Error('Stocks signals channel is not configured.');
  const messages = await signals.messages.fetch({ limit: 100 }).catch(() => null);
  const existing = messages?.find((message) => message.author.id === client.user.id
    && message.embeds.some((embed) => embed.footer?.text?.includes(`STOCK-STATUS:${status.dateKey}`)));
  if (existing) return existing;
  const embed = new EmbedBuilder().setColor(COLORS.blue)
    .setTitle(`OmniMod Stocks operating status | ${status.dateKey}`)
    .setDescription('The Stocks bot is connected and its scheduler is running. U.S. cash-equity markets are closed for the weekend, so no new intraday setup is being evaluated today. The next opening slate will report the screening result even when no stock qualifies.')
    .addFields(
      { name: 'Signal readiness', value: status.modelStatus, inline: false },
      { name: 'What to expect', value: 'The bot will resume scheduled scans during the next eligible market session. An empty trade slate means the quality and model gates did not approve an entry; it is not a missing post.', inline: false }
    )
    .setFooter({ text: `STOCK-STATUS:${status.dateKey} | Operational update; research and paper tracking only.` })
    .setTimestamp();
  return signals.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

export async function postOpeningSummary(client, guildId, discovery) {
  const { signals, settings } = await resolveResources(client, guildId);
  if (!signals?.isTextBased()) throw new Error('Stocks signals channel is not configured.');
  const existing = await findDailyDiscoveryMessage(client, guildId, discovery.dateKey);
  if (existing) return existing;
  const embed = new EmbedBuilder().setColor(COLORS.purple).setTitle(`SHORT-TERM STOCK RESEARCH SLATE | ${discovery.dateKey}`)
    .setDescription(`Screened **${observedCount(discovery.assetsScreened)}** stock and market-context symbols · **${discovery.predictions.length}** conditional paper setups. Highlights are a subset of this scan, not the entire universe.\n${discovery.predictions.length ? 'Approved paper plans are posted separately with entry, exit and risk levels.' : 'No setup completed every approval gate yet. Scanning continues.'}`)
    .addFields(
      { name: 'Screen result', value: `Quality-gated: ${discovery.diagnostics?.strictQualified || 0} | Confirmed: ${discovery.diagnostics?.confirmed || 0} | Model-approved: ${discovery.diagnostics?.modelApproved || 0} | Portfolio-selected: ${discovery.diagnostics?.portfolioSelected || 0} | Correlation/exposure rejected: ${discovery.diagnostics?.portfolioRejected || 0} | Pending confirmation: ${discovery.diagnostics?.pendingConfirmation || 0}`, inline: false },
      { name: 'Risk circuit breaker', value: embedText(discovery.diagnostics?.circuitBreaker?.triggered ? discovery.diagnostics.circuitBreaker.reason : `Clear | today ${Number(discovery.diagnostics?.circuitBreaker?.dailyR || 0).toFixed(2)}R | ${discovery.diagnostics?.circuitBreaker?.consecutiveLosses || 0} consecutive loss(es)`, 180), inline: false },
      { name: 'Provider snapshot', value: embedText(`${discovery.source || 'market provider'}${discovery.stale ? ' | stale fallback' : ''}`, 200), inline: false }
      ,{ name: 'Portfolio readiness', value: embedText(discovery.diagnostics?.portfolioReadiness || 'No portfolio selection evidence yet.', 250), inline: false }
      ,{ name: 'Model readiness', value: embedText(discovery.modelStatus || 'Model status unavailable.', 250), inline: false }
      ,{ name: 'Day-trading watch coverage', value: discovery.watchOnly?.length
        ? `Showing ${Math.min(5, discovery.watchOnly.length)} current highlights from ${observedCount(discovery.assetsScreened)} scanned symbols. The bot keeps screening for new and improving conditions.`
        : 'No current watches met the data and directional screen. Scanning continues.', inline: false }
      ,...(discovery.watchOnly || []).slice(0, 5).map(stockWatchField)
    )
    .setFooter({ text: `STOCK-SLATE:${discovery.dateKey} | Research only; not financial advice.` }).setTimestamp();
  const content = settings.alertRoleId && discovery.predictions.length ? `<@&${settings.alertRoleId}>` : undefined;
  return signals.send({ content, embeds: [embed], allowedMentions: { roles: content ? [settings.alertRoleId] : [] } });
}

export function stockWatchField(row) {
  const quote = Number(row.price) > 0 ? formatPrice(row.price) : 'unavailable';
  const observedAt = Date.parse(row.observedAt || '');
  const observed = Number.isFinite(observedAt) ? ` · <t:${Math.floor(observedAt / 1000)}:t>` : '';
  const reasons = embedText((row.reasons || []).map(safeLabel).join(', ') || 'further confirmation', 150);
  const metrics = [row.change1h == null ? null : `1h ${formatPercent(row.change1h)}`,
    row.changeDay == null ? null : `${row.session === 'pre_market' ? 'premarket' : 'session'} ${formatPercent(row.changeDay)} vs prior close`,
    row.relativeVolume == null ? null : `RVOL ${Number(row.relativeVolume).toFixed(2)}x`].filter(Boolean).join(' · ');
  const levels = row.referenceEntry > 0 && row.referenceTarget1 > 0 && row.referenceInvalidation > 0
    ? `\nATR scenario only: reference ${formatPrice(row.referenceEntry)} · target ${formatPrice(row.referenceTarget1)} · invalidation ${formatPrice(row.referenceInvalidation)}. Not an approved entry.` : '';
  return { name: safeLabel(`${row.symbol} · ${row.direction || 'DIRECTION UNCLEAR'}`), value: embedText(
    `Observed **${quote}**${observed}${row.priceSource ? ` · ${safeLabel(row.priceSource)}` : ''}\n${metrics}\nWhy on radar: ${row.screen || (row.premarketBreakout ? '20-session high cleared' : 'developing short-term trend')}.\nNeeds: ${reasons}.\nStrength ${Number(row.score || 0).toFixed(0)}/100 is a screen rank, not profit probability.${levels}`, 620) };
}

export function stockWatchEmbed(dateKey, watchRows, coverage = {}) {
  const premarket = watchRows.some(row => row.session === 'pre_market');
  return new EmbedBuilder().setColor(COLORS.blue)
    .setTitle(`OmniMod Stocks · ${premarket ? 'Premarket breakout' : 'Day-trading'} watches`)
    .setDescription(`${observedCount(coverage.assetsScreened)} symbols screened. Showing ${Math.min(5, watchRows.length)} new or improved highlights; these are a subset of the scan, not the entire universe.\nWatches show developing opportunities; none is an approved entry. ${premarket ? 'These use extended-hours data; premarket spreads and liquidity require extra care. ' : ''}A separate paper-setup alert supplies the confirmed plan.`)
    .addFields(...watchRows.slice(0, 5).map(stockWatchField))
    .setFooter({ text: `STOCK-WATCH:${dateKey} | Intraday research · no order placed` }).setTimestamp();
}

export async function postResearchWatchUpdate(client, guildId, dateKey, watchRows, coverage = {}) {
  if (!watchRows.length) return null;
  const { signals } = await resolveResources(client, guildId);
  if (!signals?.isTextBased()) return null;
  return signals.send({ embeds: [stockWatchEmbed(dateKey, watchRows, coverage)], allowedMentions: { parse: [] } });
}

export async function postDailyReview(client, guildId, discovery, predictions = []) {
  const { results } = await resolveResources(client, guildId);
  if (!results?.isTextBased()) return null;
  const messages = await results.messages.fetch({ limit: 100 }).catch(() => null);
  const existing = messages?.find((message) => message.author.id === client.user.id
    && message.embeds.some((embed) => embed.footer?.text?.includes(`STOCK-REVIEW:${discovery.dateKey}`)));
  if (existing) return existing;
  const rows = predictions.filter((row) => row.dateKey === discovery.dateKey);
  const notFilled = rows.filter((row) => row.status === 'not_filled');
  const trades = rows.filter((row) => row.status !== 'not_filled');
  const closed = trades.filter((row) => ['loss', 'fell_short', 'target_hit', 'exceeded'].includes(row.status));
  const targets = closed.filter((row) => ['target_hit', 'exceeded'].includes(row.status));
  const returns = trades.map((row) => ({ row, value: row.netReturnPct !== null && row.netReturnPct !== undefined && Number.isFinite(Number(row.netReturnPct))
    ? Number(row.netReturnPct) : Number(row.entryPrice) > 0 && Number(row.currentPrice) > 0
      ? (Number(row.currentPrice) / Number(row.entryPrice) - 1) * 100 : NaN })).filter((item) => Number.isFinite(item.value));
  const best = [...returns].sort((a, b) => b.value - a.value)[0];
  const worst = [...returns].sort((a, b) => a.value - b.value)[0];
  const embed = new EmbedBuilder().setColor(COLORS.purple).setTitle(`SHORT-TERM PAPER REVIEW | ${discovery.dateKey}`)
    .setDescription(rows.length
      ? 'Closing review of today\'s persisted paper setups. Any still-open setup remains visible in the tracker; this report creates no new trade.'
      : 'No conditional paper setup was approved or posted today. Research-watch symbols were observations, not entries, and are excluded from target and performance counts.')
    .addFields(
      { name: 'Slate', value: `${rows.length} proposed | ${notFilled.length} not filled | ${closed.length} graded | ${trades.length - closed.length} still open`, inline: false },
      { name: 'Graded outcomes', value: `Target 1 hits: ${targets.length} | Target 2 hits: ${closed.filter((r) => r.status === 'exceeded').length} | Shortfalls: ${closed.filter((r) => r.status === 'fell_short').length} | Losses/invalidation: ${closed.filter((r) => r.status === 'loss').length}`, inline: false },
      { name: 'Best observed', value: best ? `${best.row.symbol} ${formatPercent(best.value)}` : 'No setup posted', inline: true },
      { name: 'Weakest observed', value: worst ? `${worst.row.symbol} ${formatPercent(worst.value)}` : 'No setup posted', inline: true },
      { name: 'Data source', value: discovery.source || 'market provider cache', inline: false }
    )
    .setFooter({ text: `STOCK-REVIEW:${discovery.dateKey} | Paper research only; not audited performance.` }).setTimestamp();
  return results.send({ embeds: [embed] });
}

export async function postNewPrediction(client, guildId, prediction) {
  const { signals, settings } = await resolveResources(client, guildId);
  if (!signals?.isTextBased()) throw new Error('Stocks signals channel is not configured.');
  const notifyRoleId = settings.alertRoleId || settings.adminRoleId;
  const notifyUserId = notifyRoleId ? '' : settings.configuredBy;
  const content = notifyRoleId ? `<@&${notifyRoleId}>` : notifyUserId ? `<@${notifyUserId}>` : undefined;
  return signals.send({
    content,
    embeds: [predictionEmbed(prediction)],
    allowedMentions: {
      roles: notifyRoleId ? [notifyRoleId] : [],
      users: notifyUserId ? [notifyUserId] : []
    }
  });
}

export async function postOutcome(client, guildId, outcome) {
  const { results } = await resolveResources(client, guildId);
  if (!results?.isTextBased()) return null;
  const labels = { loss: 'Paper setup invalidated', fell_short: 'Paper setup fell short', target_hit: 'Target 1 reached', target_closed: 'Target 1 secured', exceeded: 'Target 2 reached', risk_warning: 'Sell / reduce review', risk_reduced: 'Risk reduced', risk_closed: 'Breakeven risk exit', entry_filled: 'Conditional buy zone filled', not_filled: 'Entry expired — no trade' };
  return results.send({ embeds: [predictionEmbed(outcome.prediction, { title: `SHORT-TERM PAPER TRADE RESULT | ${outcome.prediction.symbol} | ${labels[outcome.type] || 'Outcome update'}`, color: outcome.color, description: outcome.description })] });
}

export function alertButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('stocks_alerts_in').setLabel('Enable stock alerts').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('stocks_alerts_out').setLabel('Disable alerts').setStyle(ButtonStyle.Secondary)
  );
}

export async function postRolePanel(client, guildId) {
  const { signals } = await resolveResources(client, guildId);
  if (!signals?.isTextBased()) throw new Error('Stocks signals channel is not configured.');
  const embed = new EmbedBuilder().setColor(COLORS.purple).setTitle('OmniMod Stocks alerts')
    .setDescription('Opt in to research-slate notifications. This role does not enable trading, brokerage access, or personalized financial advice.');
  return signals.send({ embeds: [embed], components: [alertButtons()] });
}

export async function handleAlertButton(interaction) {
  const settings = await getGuildSettings(interaction.guildId);
  if (!settings.alertRoleId) return interaction.reply({ content: 'The stock-alert role is not configured.', ephemeral: true });
  const enable = interaction.customId === 'stocks_alerts_in';
  if (enable) await interaction.member.roles.add(settings.alertRoleId); else await interaction.member.roles.remove(settings.alertRoleId);
  return interaction.reply({ content: enable ? 'Stock research alerts enabled.' : 'Stock research alerts disabled.', ephemeral: true });
}
