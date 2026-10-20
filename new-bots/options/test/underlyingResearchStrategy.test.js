import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateUnderlyingResearch, reconcileUnderlyingResearch, UNDERLYING_RESEARCH_HASH, UNDERLYING_RESEARCH_RULES } from '../src/underlyingResearchStrategy.js';
import { researchInput, researchBars, NOW } from './underlyingResearchFixtures.js';

test('frozen independent hypothesis produces long and short underlying research without upstream signals', () => {
  assert.ok(Object.isFrozen(UNDERLYING_RESEARCH_RULES));
  const long = evaluateUnderlyingResearch(researchInput());
  assert.equal(long.status, 'technical_watch');
  assert.equal(long.direction, 'long');
  assert.equal(long.eligibleForPaper, false);
  assert.equal(long.configHash, UNDERLYING_RESEARCH_HASH);
  assert.equal(long.probability, undefined);
  assert.equal(long.referenceLevels.entry, 100.41);
  assert.equal(long.referenceLevels.invalidation, 100);
  assert.ok(Math.abs(long.referenceLevels.target - 101.23) < 1e-9);
  assert.equal(long.metrics.relativeVolume, 2);
  const short = evaluateUnderlyingResearch(researchInput({ bars: researchBars({ direction: 'short' }),
    quote: { ...researchInput().quote, bp: 99.59, ap: 99.61 } }));
  assert.equal(short.status, 'technical_watch');
  assert.equal(short.direction, 'short');
  assert.ok(Math.abs(short.referenceLevels.target - 98.77) < 1e-9);
});

test('first-cross observation window accepts previous minute but rejects an already mature move', () => {
  assert.equal(evaluateUnderlyingResearch(researchInput({ bars: researchBars({ crossIndex: 28 }) })).status, 'technical_watch');
  const old = evaluateUnderlyingResearch(researchInput({ bars: researchBars({ crossIndex: 27 }) }));
  assert.equal(old.status, 'strategy_rejected');
  assert.deepEqual(old.reasons, ['no_recent_opening_range_cross']);
  assert.equal(evaluateUnderlyingResearch(researchInput({ bars: researchBars({ crossVolume: 1000 }) })).reasons[0], 'relative_volume_below_research_rule');
});

test('invalid or incomplete minute sequences never pass the data gate', () => {
  const cases = [
    (x) => { x.bars.splice(2, 1); },
    (x) => { x.bars[2] = { ...x.bars[1] }; },
    (x) => { x.bars.reverse(); },
    (x) => { x.bars[2].t = '2026-10-02T13:32:00'; },
    (x) => { x.bars[2].v = '1000'; },
    (x) => { x.bars[2].vw = 101; },
    (x) => { x.bars[2].o = true; },
    (x) => { x.bars.push({ ...x.bars.at(-1), t: '2026-10-02T14:00:00Z' }); },
    (x) => { x.bars[2].h = 99; },
    (x) => { x.bars = []; },
  ];
  for (const mutate of cases) {
    const input = researchInput(); mutate(input);
    const result = evaluateUnderlyingResearch(input);
    assert.equal(result.status, 'data_rejected', JSON.stringify(input));
    assert.equal(result.dataReady, false);
    assert.equal(result.eligibleForPaper, false);
  }
});

test('strict quote timestamps, size, spread and drift gates still apply to research', () => {
  const cases = [
    { t: new Date(NOW - 16000).toISOString() }, { t: new Date(NOW + 1).toISOString() },
    { bs: 0 }, { as: '10' }, { bp: 101, ap: 100.4 }, { bp: 100, ap: 101 }, { bp: 101.2, ap: 101.21 },
  ];
  for (const override of cases) {
    const result = evaluateUnderlyingResearch(researchInput({ quote: { ...researchInput().quote, ...override } }));
    assert.equal(result.status, 'data_rejected');
  }
  const stale = evaluateUnderlyingResearch(researchInput({ now: NOW + 91000, quote: { ...researchInput().quote, t: new Date(NOW + 91000).toISOString() } }));
  assert.equal(stale.reasons[0], 'stale_bars');
});

test('session limits and feed cohorts remain explicit, without a delayed-feed fallback', () => {
  assert.equal(evaluateUnderlyingResearch(researchInput({ sessionClose: '2026-10-02T14:20:00Z' })).reasons[0], 'late_session');
  assert.equal(evaluateUnderlyingResearch(researchInput({ now: Date.parse('2026-10-02T13:29:00Z') })).reasons[0], 'outside_regular_session');
  assert.equal(evaluateUnderlyingResearch(researchInput({ feed: 'delayed_sip' })).reasons[0], 'unsupported_research_feed');
  const iex = evaluateUnderlyingResearch(researchInput()), sip = evaluateUnderlyingResearch(researchInput({ feed: 'sip' }));
  assert.notEqual(iex.cohort, sip.cohort);
  assert.equal(iex.configHash, sip.configHash);
});

test('price must hold outside the opening range and stop remains bounded', () => {
  const input = researchInput({ bars: researchBars({ crossIndex: 28 }) });
  input.bars.at(-1).c = 100.1;
  input.quote.bp = 100.09; input.quote.ap = 100.11;
  assert.equal(evaluateUnderlyingResearch(input).reasons[0], 'breakout_not_held_or_vwap_disagrees');
  const wide = researchInput();
  for (const bar of wide.bars.slice(0, 15)) bar.l = 97;
  assert.equal(evaluateUnderlyingResearch(wide).reasons[0], 'invalidation_too_far');
});

test('fresh opposing primary directions withhold research while missing/stale/manual context does not masquerade as agreement', () => {
  const observation = evaluateUnderlyingResearch(researchInput({ symbol: 'BRK.B' }));
  const signal = { underlyingSymbol: 'BRK/B', primarySignalOwner: 'stocks', direction: 'short', observedAt: new Date(NOW).toISOString(), sessionDate: '2026-10-02' };
  const reconcile = (signalRows, extra = {}) => reconcileUnderlyingResearch(observation, { signalRows, now: NOW, ...extra });
  const conflict = reconcile([{ signal }]);
  assert.equal(conflict.status, 'withheld_for_conflict');
  assert.equal(conflict.referenceLevels.entry, observation.referenceLevels.entry);
  assert.equal(conflict.eligibleForPaper, false);
  assert.equal(reconcile([{ signal: { ...signal, direction: 'long' } }]).primaryContext.status, 'aligned');
  assert.equal(reconcile([]).primaryContext.status, 'context_not_verified');
  assert.equal(reconcile([], { signalMappingDiagnostics: { status: 'complete' } }).primaryContext.status, 'no_fresh_primary_context');
  assert.equal(reconcile([{ signal: { ...signal, observedAt: new Date(NOW - 120001).toISOString() } }]).status, 'technical_watch');
  assert.equal(reconcile([{ signal: { ...signal, primarySignalOwner: 'manual' } }]).status, 'technical_watch');
  assert.equal(reconcile([], { signalMappingDiagnostics: { conflicts: [{ symbol: 'BRK/B' }] } }).status, 'withheld_for_conflict');
});
