import { replayChronologicalPaper } from './chronologicalReplay.js';

function normalizeShadowConfigs(baseConfig, shadowConfigs, allowedOverrides) {
  if (!Array.isArray(shadowConfigs) || shadowConfigs.length > 3) throw new Error('At most three shadow configurations may be replayed at once.');
  const ids = new Set();
  return shadowConfigs.map((profile) => {
    const id = String(profile?.id ?? '').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/.test(id) || ids.has(id)) throw new Error('Shadow profile IDs must be unique short labels.');
    ids.add(id);
    const overrides = profile?.overrides;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || !Object.keys(overrides).length) {
      throw new Error(`Shadow profile ${id} must provide non-empty overrides.`);
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (!allowedOverrides.includes(key)) throw new Error(`Shadow profile ${id} cannot override ${key}.`);
      const validBoolean = ['stopAtOpeningRangeMidpoint', 'requireCompleteGreeks'].includes(key) && typeof value === 'boolean';
      const validNumber = typeof value === 'number' && Number.isFinite(value) && value >= 0;
      if (!validBoolean && !validNumber) throw new Error(`Shadow profile ${id} has an invalid value for ${key}.`);
    }
    return { id, overrides, config: { ...baseConfig, ...overrides } };
  });
}

/** Replay fixed strategy variants on identical observations with isolated paper ledgers and unchanged risk policy. */
export async function replayWithShadowConfigs({ baseOptions, baseConfig = {}, shadowConfigs = [], allowedOverrides, evaluateForConfig }) {
  if (!Array.isArray(allowedOverrides) || typeof evaluateForConfig !== 'function') throw new TypeError('Shadow replay requires an override allowlist and evaluator factory.');
  const profiles = normalizeShadowConfigs(baseConfig, shadowConfigs, allowedOverrides);
  const production = await replayChronologicalPaper({ ...baseOptions, evaluate: evaluateForConfig(baseConfig) });
  const shadows = [];
  for (const profile of profiles) {
    const report = await replayChronologicalPaper({ ...baseOptions, evaluate: evaluateForConfig(profile.config) });
    shadows.push({
      id: profile.id,
      mode: 'isolated_shadow_paper_replay',
      overrides: profile.overrides,
      report,
    });
  }
  return { ...production, shadowStrategies: shadows };
}
