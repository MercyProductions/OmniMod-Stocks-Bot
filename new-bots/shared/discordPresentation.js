/** Discord presentation only: never qualifies a strategy or changes a risk decision. */
export const MARKET_NAMES = { stocks: 'Stocks', crypto: 'Crypto', forex: 'Forex', futures: 'Futures', options: 'Options', 'etfs-etps': 'ETFs & ETPs' };
export const embedText = (value, limit = 1024) => {
  const text = String(value ?? 'Unavailable').trim() || 'Unavailable';
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
};
export const observedCount = value => Number.isInteger(value) && value >= 0 ? String(value) : 'unknown';
const number = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const price = value => number(value) === null ? 'unavailable' : Number(value).toLocaleString('en-US', { maximumSignificantDigits: 7 });
export const safeLabel = value => embedText(value, 120).replace(/[@`*_~<>\r\n]/g, ' ');

/** Strings (including connection tests) also use embeds. Structured payloads fail before delivery if invalid. */
export function discordEmbedPayload(input, { title = 'OmniMod · Update' } = {}) {
  let embeds;
  if (typeof input === 'string') {
    if (!input.trim()) throw new Error('Discord message must not be empty.');
    embeds = [{ title, color: 0x8b5cf6, description: embedText(input, 4000) }];
  } else embeds = input?.embeds?.map(row => typeof row.toJSON === 'function' ? row.toJSON() : row);
  if (!Array.isArray(embeds) || !embeds.length || embeds.length > 10) throw new Error('Discord requires 1–10 embeds.');
  let total = 0;
  for (const embed of embeds) {
    for (const [value, limit] of [[embed.title, 256], [embed.description, 4096], [embed.footer?.text, 2048], [embed.author?.name, 256]]) {
      if (value !== undefined && (typeof value !== 'string' || value.length > limit)) throw new Error('Discord embed text limit exceeded.');
      total += value?.length || 0;
    }
    if ((embed.fields?.length || 0) > 25) throw new Error('Discord embed field limit exceeded.');
    for (const field of embed.fields || []) {
      if (typeof field.name !== 'string' || !field.name.length || field.name.length > 256 || typeof field.value !== 'string' || !field.value.length || field.value.length > 1024) throw new Error('Discord embed field is invalid.');
      total += field.name.length + field.value.length;
    }
  }
  if (total > 6000) throw new Error('Discord combined embed limit exceeded.');
  return { embeds, allowed_mentions: { parse: [] } };
}

export function buildDayTradingBrief({ bot, at, source, coverage, results = [], handoffRows = [], emergencyStop = true, context = [], readiness = null }) {
  const name = MARKET_NAMES[bot];
  if (!name) throw new Error('Unknown market presentation.');
  // These candidates already passed their own market's strategy/data checks. Risk-blocked rows remain watches.
  const rows = results.map(row => ({ ...row, ...(typeof row.strategy === 'object' ? row.strategy : {}) }));
  const reserved = rows.filter(row => row.status === 'reserved');
  const watches = rows.filter(row => row.candidate && row.status !== 'reserved' && row.status !== 'duplicate');
  const shownWatches = watches.slice(0, Math.max(0, 5 - handoffRows.length));
  const noMarketScan = readiness && !readiness.automatedScanRan;
  const fields = [
    ...(readiness ? [{ name: 'Market-data status', value: embedText(readiness.label + '\n' + readiness.detail, 400) }] : []),
    { name: 'Scan coverage', value: embedText(coverage, readiness ? 550 : 700) },
    { name: 'This scan', value: `${noMarketScan ? 'Automated current-market scan not completed. Manual-file results, if any, are separate.\n' : ''}${reserved.length} paper reservations · ${watches.length} strategy-qualified watches awaiting risk approval\nShowing ${handoffRows.length} reservations and ${shownWatches.length} watches. These highlights are a subset of the scan, not the entire universe.` },
    { name: 'Operating state', value: emergencyStop ? `Paper entries paused by emergency stop. ${noMarketScan ? 'Market-data setup/session status is separate from this stop.' : 'Data collection can continue.'} No live orders.` : 'Paper simulation only. Reservations are pending conditional fills; no live orders.' },
  ];
  for (const row of handoffRows) {
    const result = reserved.find(result => result.reservation?.order?.orderId === row.id);
    const candidate = result?.candidate || {}, order = result?.reservation?.order || {};
    const deadline = Date.parse(candidate.forceExitAt || order.forceExitAt || '');
    // Exposure direction is deliberately separate: buying an inverse ETF is not a short order.
    fields.push({ name: safeLabel(`${row.symbol} · PAPER RESERVED`),
      value: embedText(`Strategy: ${safeLabel(candidate.strategyId || row.strategyId)}\nInstrument: ${safeLabel(row.instrumentKey)} · position ${safeLabel(order.direction || candidate.direction || 'unavailable')} · exposure bias ${safeLabel(row.direction)}\n`
        + `${bot === 'options' ? 'Spread premium' : 'Conditional paper levels'}: entry ${price(order.entryPrice)} · stop ${price(order.stopPrice)} · target ${price(order.targetPrice)}\n`
        + `Size ${price(order.units ?? order.quantity)} units · fees ${price(candidate.roundTripFeesPerUnit)} + slippage reserve ${price(candidate.slippageReservePerUnit)} per unit\n`
        + `${Number.isFinite(deadline) ? `Exit deadline <t:${Math.floor(deadline / 1000)}:t>. ` : ''}Awaiting fill. Profit probability is not calibrated.`, readiness ? 600 : 700) });
  }
  for (const row of shownWatches) {
    const candidate = row.candidate;
    const reasons = row.decision?.reasons || row.reservation?.reasons || row.reasons || [row.reservation?.reason || row.status];
    fields.push({ name: safeLabel(`${row.symbol || row.instrument || candidate.instrumentKey} · WATCH — NOT APPROVED`),
      value: embedText(`Strategy: ${safeLabel(candidate.strategyId || row.strategy || 'intraday')} · ${safeLabel(candidate.side || candidate.direction || 'direction unavailable')}\nScenario only: entry ${price(candidate.entryPrice)} · stop ${price(candidate.stopPrice)} · target ${price(candidate.targetPrice)}\nNeeds: ${reasons.map(safeLabel).join(', ')}\nTechnical conditions passed; risk approval has not. No calibrated profit probability.`, readiness ? 500 : 650) });
  }
  if (!reserved.length && !watches.length) fields.push({ name: 'Current focus', value: noMarketScan
    ? 'No live-market opportunity conclusion is available from this run. See the data status and setup step.'
    : 'No candidate passed the day-trading strategy and data checks in this scan. The next eligible scan will evaluate again; no profitable watch is being implied.' });
  if (readiness?.nextStep) fields.push({ name: 'Next setup / diagnostic step', value: embedText(readiness.nextStep, 300) });
  if (context.length) fields.push({ name: 'Session / data context', value: embedText(context.join('\n'), readiness ? 450 : 650) });
  fields.push({ name: 'Market data', value: embedText(source, 250) });
  return discordEmbedPayload({ embeds: [{ title: `OmniMod ${name} · ${noMarketScan ? 'Scanner status' : 'Day-trading scan'}`, color: noMarketScan ? 0xf59e0b : 0x8b5cf6,
    description: noMarketScan ? 'Market-data readiness report. This is not a completed full-market opportunity scan.'
      : 'Current intraday opportunities, with the strategy decision and remaining conditions shown separately.', fields,
    ...(Number.isFinite(Date.parse(at)) ? { timestamp: new Date(at).toISOString() } : {}),
    footer: { text: 'Paper research · includes risk and cost checks · a watch is not an entry or a profit forecast' } }] });
}
