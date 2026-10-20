function parseTime(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`${label} must be an ISO-8601 timestamp with an explicit UTC offset.`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${label} must be a valid timestamp.`);
  return time;
}

/**
 * Evaluate one frozen strategy over explicit chronological holdout windows.
 * Pre-window observations/bars are retained only for indicator warm-up; the
 * replay engine's scoreFrom gate prevents them from creating paper trades.
 */
export async function replayChronologicalWindows({ replay, dataset, windows }) {
  if (typeof replay !== 'function') throw new TypeError('A replay function is required.');
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) throw new TypeError('A replay dataset is required.');
  if (Object.hasOwn(dataset, 'scoreFrom')) throw new Error('Set scoreFrom through evaluation windows, not in the base dataset.');
  if (!Array.isArray(dataset.observations) || !dataset.observations.length) throw new Error('Chronological observations are required.');
  if (!Array.isArray(windows) || windows.length < 2 || windows.length > 20) throw new Error('Provide between two and twenty chronological holdout windows.');

  let previousObservationAt = -Infinity;
  const observations = dataset.observations.map((observation) => {
    const at = parseTime(observation?.asOf, 'Observation asOf');
    if (at <= previousObservationAt) throw new Error('Dataset observations must be strictly chronological.');
    previousObservationAt = at;
    return { observation, at };
  });
  const finalObservationAt = observations.at(-1).at;
  let previousResolutionEnd = -Infinity;
  const ids = new Set();
  const results = [];
  for (const [index, window] of windows.entries()) {
    const id = String(window?.id ?? '').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/.test(id) || ids.has(id)) throw new Error('Holdout window IDs must be unique short labels.');
    ids.add(id);
    const startAt = parseTime(window?.start, `Window ${id} start`);
    const endAt = parseTime(window?.end, `Window ${id} end`);
    const resolutionEndAt = window?.resolutionEnd == null ? endAt : parseTime(window.resolutionEnd, `Window ${id} resolutionEnd`);
    if (startAt >= endAt || resolutionEndAt < endAt || (index > 0 && startAt <= previousResolutionEnd))
      throw new Error('Holdout windows must have positive duration, ordered non-overlapping resolution periods, and a resolutionEnd no earlier than end.');
    if (index === 0 && startAt < observations[0].at) throw new Error('A holdout window cannot start before the dataset.');
    if (resolutionEndAt > finalObservationAt) throw new Error(`Holdout window ${id} resolutionEnd ends after the dataset's final observation.`);
    const scored = observations.filter(({ at }) => at >= startAt && at <= endAt);
    if (!scored.length) throw new Error(`Holdout window ${id} contains no observations.`);
    const boundedObservations = observations.filter(({ at }) => at <= resolutionEndAt).map(({ observation }) => observation);
    const report = await replay({ ...dataset, observations: boundedObservations,
      scoreFrom: new Date(startAt).toISOString(), scoreThrough: new Date(endAt).toISOString() });
    results.push({ id, start: new Date(startAt).toISOString(), end: new Date(endAt).toISOString(),
      resolutionEnd: new Date(resolutionEndAt).toISOString(), warmupObservations: boundedObservations.filter((row) => parseTime(row.asOf, 'Observation asOf') < startAt).length,
      scoredObservations: scored.length, resolutionObservations: boundedObservations.filter((row) => parseTime(row.asOf, 'Observation asOf') > endAt).length, report });
    previousResolutionEnd = resolutionEndAt;
  }
  return {
    mode: 'fixed-strategy-chronological-holdout-windows',
    windows: results,
    methodology: 'Each explicit score window uses a fresh isolated paper ledger. Earlier observations are warm-up only. An optional resolutionEnd supplies later quotes solely to manage existing paper orders; scoreThrough prevents new decisions after the score window. The next score window must start after the prior resolutionEnd (purge/embargo). Strategy parameters are unchanged and no fitting occurs. Reports are descriptive holdouts only if dates and strategy were fixed before inspecting outcomes.',
  };
}
