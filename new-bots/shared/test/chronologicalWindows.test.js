import test from 'node:test';
import assert from 'node:assert/strict';
import { replayChronologicalWindows } from '../chronologicalWindows.js';
import { replayPayload } from '../replayPayload.js';

const observations = [
  { asOf: '2026-01-01T15:00:00.000Z' },
  { asOf: '2026-01-02T15:00:00.000Z' },
  { asOf: '2026-01-03T15:00:00.000Z' },
  { asOf: '2026-01-04T15:00:00.000Z' },
  { asOf: '2026-01-05T15:00:00.000Z' },
];

test('chronological holdout windows keep earlier observations as warm-up and reset each evaluation', async () => {
  const seen = [];
  const result = await replayChronologicalWindows({
    replay: async (input) => {
      const scored = input.observations.filter((row) => Date.parse(row.asOf) >= Date.parse(input.scoreFrom));
      seen.push({ scoreFrom: input.scoreFrom, observed: input.observations.length, scored: scored.length });
      return { scoreFrom: input.scoreFrom, scoredObservations: scored.length };
    },
    dataset: { observations, bars: [], config: { frozen: true } },
    windows: [
      { id: 'holdout-a', start: observations[1].asOf, end: observations[2].asOf },
      { id: 'holdout-b', start: observations[3].asOf, end: observations[4].asOf },
    ],
  });
  assert.equal(result.mode, 'fixed-strategy-chronological-holdout-windows');
  assert.deepEqual(seen, [
    { scoreFrom: observations[1].asOf, observed: 3, scored: 2 },
    { scoreFrom: observations[3].asOf, observed: 5, scored: 2 },
  ]);
  assert.equal(result.windows[1].warmupObservations, 3);
});

test('resolution buffer is monitoring-only and the next score window starts after it', async () => {
  const inputsSeen = [];
  const result = await replayChronologicalWindows({
    replay: async (input) => { inputsSeen.push(input); return {}; },
    dataset: { observations, bars: [] },
    windows: [
      { id: 'a', start: observations[0].asOf, end: observations[1].asOf, resolutionEnd: observations[2].asOf },
      { id: 'b', start: observations[3].asOf, end: observations[4].asOf },
    ],
  });
  assert.deepEqual(inputsSeen[0].observations, observations.slice(0, 3));
  assert.equal(inputsSeen[0].scoreFrom, observations[0].asOf);
  assert.equal(inputsSeen[0].scoreThrough, observations[1].asOf);
  assert.equal(inputsSeen[1].scoreFrom, observations[3].asOf);
  assert.equal(inputsSeen[1].scoreThrough, observations[4].asOf);
  assert.equal(result.windows[0].resolutionObservations, 1);
  assert.equal(result.windows[0].scoredObservations, 2);
  assert.equal(result.windows[0].warmupObservations, 0);
  const replay = async () => ({});
  await assert.rejects(replayChronologicalWindows({ replay, dataset: { observations }, windows: [
    { id: 'a', start: observations[0].asOf, end: observations[1].asOf, resolutionEnd: observations[3].asOf },
    { id: 'b', start: observations[3].asOf, end: observations[4].asOf },
  ] }), /resolution periods/);
  await assert.rejects(replayChronologicalWindows({ replay, dataset: { observations }, windows: [
    { id: 'a', start: observations[0].asOf, end: observations[1].asOf, resolutionEnd: '2026-01-06T15:00:00.000Z' },
    { id: 'b', start: observations[2].asOf, end: observations[3].asOf },
  ] }), /resolutionEnd ends after/);
});

test('chronological holdout windows reject overlap, duplicates, empty periods and scoreFrom leakage', async () => {
  const replay = async () => ({});
  const dataset = { observations };
  const valid = [
    { id: 'a', start: observations[0].asOf, end: observations[1].asOf },
    { id: 'b', start: observations[2].asOf, end: observations[3].asOf },
  ];
  await assert.rejects(replayChronologicalWindows({ replay, dataset, windows: [valid[0], { ...valid[1], start: observations[1].asOf }] }), /non-overlapping resolution periods/);
  await assert.rejects(replayChronologicalWindows({ replay, dataset, windows: [valid[0], { ...valid[1], id: 'a' }] }), /unique/);
  await assert.rejects(replayChronologicalWindows({ replay, dataset, windows: [valid[0], { id: 'empty', start: '2026-01-02T15:00:01.000Z', end: '2026-01-03T14:59:59.000Z' }] }), /no observations/);
  await assert.rejects(replayChronologicalWindows({ replay, dataset: { ...dataset, scoreFrom: observations[0].asOf }, windows: valid }), /through evaluation windows/);
});

test('shared replay payload routes explicit windows consistently and preserves ordinary single replay', async () => {
  const calls = [];
  const replay = async (input) => { calls.push(input); return { owner: input.owner, scoreFrom: input.scoreFrom ?? null }; };
  const ordinary = await replayPayload({ owner: 'futures', observations, contract: { contractId: 'ESZ6' } }, replay);
  assert.deepEqual(ordinary, { owner: 'futures', scoreFrom: null });
  const windows = await replayPayload({ owner: 'futures', observations, contract: { contractId: 'ESZ6' }, evaluationWindows: [
    { id: 'w1', start: observations[0].asOf, end: observations[1].asOf },
    { id: 'w2', start: observations[2].asOf, end: observations[4].asOf },
  ] }, replay);
  assert.equal(windows.windows.length, 2);
  assert.equal(calls.length, 3);
  await assert.rejects(replayPayload({ observations, evaluationWindows: null }, replay), /between two and twenty/);
});

test('holdout windows require explicit-offset timestamps and cannot extend past observed data', async () => {
  const replay = async () => ({});
  await assert.rejects(replayChronologicalWindows({ replay, dataset: { observations }, windows: [
    { id: 'a', start: observations[0].asOf, end: observations[1].asOf },
    { id: 'b', start: observations[2].asOf, end: '2026-01-06T15:00:00.000Z' },
  ] }), /after the dataset/);
  await assert.rejects(replayChronologicalWindows({ replay, dataset: { observations }, windows: [
    { id: 'a', start: '2026-01-01T15:00:00', end: observations[1].asOf },
    { id: 'b', start: observations[2].asOf, end: observations[3].asOf },
  ] }), /explicit UTC offset/);
});
