import { PREDICTIVE_SCHEMA, FORECAST_HORIZONS } from './predictiveObservation.js';

/** Called by an isolated worker, never awaited by the production scanner. */
export async function requestPredictiveForecast(observation, { endpoint, token, fetcher = fetch } = {}) {
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/forecast') throw new Error('Invalid forecasting endpoint');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
    throw new Error('Forecasting requires HTTPS or numeric loopback');
  if (!token || token.length < 32) throw new Error('Dedicated forecasting token required');
  if (observation.schema !== PREDICTIVE_SCHEMA) throw new Error('Unsupported observation schema');
  const response = await fetcher(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(observation), redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Forecasting service HTTP ${response.status}`);
  let bytes = 0; const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 2_000_000) { await response.body.cancel?.().catch(() => {}); throw new Error('Oversized forecasting response'); }
    chunks.push(Buffer.from(chunk));
  }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Array.isArray(result.forecasts) || result.forecasts.length !== FORECAST_HORIZONS.length
    || result.forecasts.some((row, index) => row.observationId !== observation.id || row.horizon !== FORECAST_HORIZONS[index]
      || row.productionApproval !== false || !['abstain', 'experimental_forecast'].includes(row.status)
      || row.calibratedProbability !== null)) throw new Error('Invalid experimental forecast contract');
  return result;
}
