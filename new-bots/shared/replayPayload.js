import { replayChronologicalWindows } from './chronologicalWindows.js';

/** Run a replay payload directly or evaluate its explicit frozen-strategy windows. */
export async function replayPayload(payload, replay) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Replay dataset must be a JSON object.');
  if (typeof replay !== 'function') throw new TypeError('A replay function is required.');
  if (!Object.hasOwn(payload, 'evaluationWindows')) return replay(payload);
  const { evaluationWindows, ...dataset } = payload;
  return replayChronologicalWindows({ replay, dataset, windows: evaluationWindows });
}
