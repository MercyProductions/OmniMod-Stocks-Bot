import { formatDiagnosticCount } from '../../shared/formatDiagnosticCount.js';

function price(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `$${number.toFixed(number < 1 ? 4 : 2)}` : 'n/a';
}

export function formatEtfCount(value) {
  return formatDiagnosticCount(value);
}

export function formatEtfDiscoverySummary(discovery) {
  if (discovery?.mode === 'full-market-directory') {
    const screen = discovery.cheapScreen;
    return `Universe: ${formatEtfCount(discovery.universeSize)} listed ETFs/ETPs · ${formatEtfCount(discovery.activeTradableCandidates)} eligible\n`
      + `${formatEtfCount(screen?.attemptedSymbols)} snapshot requests (symbols) · ${formatEtfCount(screen?.returnedSymbols)} returned · ${formatEtfCount(screen?.cheaplyScreened)} usable screens · ${formatEtfCount(discovery.selectedCandidates)} shortlisted`
      + (screen && screen.status !== 'screen_complete' ? ` · ${screen.status}` : '');
  }
  if (discovery?.mode !== 'dynamic-directory-and-screener') return null;
  return `Universe: ${formatEtfCount(discovery.universeSize)} listed ETFs/ETPs · ${formatEtfCount(discovery.selectedCandidates)} selected (${formatEtfCount(discovery.screenerCandidates)} active/mover · ${formatEtfCount(discovery.curatedCandidates)} curated) · ${formatEtfCount(discovery.activeTradableCandidates)} active/tradable${discovery.screenerFailure ? ' · screener fallback used' : ''}`;
}

/** Compact, explicit paper-only setup context for Discord scan summaries. */
export function formatEtfResult(row) {
  const symbol = String(row?.symbol || 'Unknown').replace(/[^A-Z0-9.-]/gi, '').slice(0, 10) || 'Unknown';
  const status = String(row?.status || 'unknown').replace(/[^a-z0-9-]/gi, '').slice(0, 30);
  const candidate = row?.candidate;
  if (!candidate || !['reserved', 'risk-blocked'].includes(status)) {
    const reason = row?.decision?.reasons?.join(', ') || row?.reasons?.join(', ') || row?.strategy || status;
    return `${symbol} | ${status} | ${String(reason).replace(/[\r\n]/g, ' ').slice(0, 100)}`;
  }
  const signal = candidate.signal || {};
  const volume = signal.timeOfDayRelativeVolume || {};
  const volumeText = volume.status === 'available' && Number.isFinite(Number(volume.ratio))
    ? `ToD RVOL ${Number(volume.ratio).toFixed(2)}x/${Number(volume.sampleSessions) || 0} sessions`
    : `ToD RVOL ${String(volume.status || 'unavailable').replace(/[^a-z0-9_-]/gi, '').slice(0, 32)}`;
  const risk = Number(row?.decision?.sizing?.proposedRiskUsd);
  const rr = Number(row?.decision?.sizing?.rewardRisk);
  const sameSessionRelativeVolume = Number(signal.relativeVolume);
  const metadata = candidate.instrumentMetadata;
  const instrumentContext = metadata?.productType
    ? ` | ${String(metadata.productType).replace(/[^a-z0-9_-]/gi, '').slice(0, 32).toUpperCase()} ${Number.isFinite(Number(metadata.leverage)) ? `${Number(metadata.leverage)}x` : 'leverage n/a'}${metadata.inverse ? ' inverse' : ''}`
    : '';
  const riskContext = Array.isArray(metadata?.riskNotices) && metadata.riskNotices.length
    ? ` | Product risk: ${metadata.riskNotices.map((notice) => ({
      daily_reset_path_risk: 'daily reset/path risk (not modeled)',
      issuer_credit_risk_not_modeled: 'ETN issuer credit risk (not modeled)',
      futures_roll_risk_not_modeled: 'commodity futures-roll risk (not modeled)',
    }[notice] || 'unclassified product risk')).join('; ')}`
    : '';
  const paperState = status === 'reserved' ? 'PAPER RESERVED (not a fill)' : 'PAPER RISK BLOCKED';
  return `${symbol} ${String(candidate.direction || 'unknown').toUpperCase()}${instrumentContext}${riskContext} | ${paperState} | Entry ${price(candidate.entryPrice)} · Stop ${price(candidate.stopPrice)} · Target ${price(candidate.targetPrice)} | Net R:R ${Number.isFinite(rr) ? rr.toFixed(2) : 'n/a'}${Number.isFinite(risk) ? ` · Risk budget $${risk.toFixed(2)}` : ''} | Session RVOL ${Number.isFinite(sameSessionRelativeVolume) ? `${sameSessionRelativeVolume.toFixed(2)}x` : 'n/a'} · ${volumeText}`;
}

/** Keep risk-approved paper candidates visible ahead of screening rejections in bounded webhook text. */
export function prioritizeEtfAlertRows(rows, limit = 5) {
  if (!Array.isArray(rows) || !Number.isInteger(limit) || limit < 1) return [];
  const priority = (row) => row?.status === 'reserved' ? 0 : row?.status === 'risk-blocked' ? 1 : 2;
  return rows.map((row, index) => ({ row, index })).sort((a, b) => priority(a.row) - priority(b.row) || a.index - b.index)
    .slice(0, limit).map(({ row }) => row);
}
