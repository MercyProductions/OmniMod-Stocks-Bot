import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { inspectNasdaqEtfDirectory, parseNasdaqEtfDirectory, mergeEtfDirectories } from '../../shared/nasdaqEtfDirectory.js';
import { probePublicEtfDirectory, savePublicEtfDirectoryProbe } from '../src/publicDirectoryProbe.js';

const time = Date.parse('2026-10-03T10:00:00Z');
const footer = 'File Creation Time: 1002202618:12';
const nasdaq = rows => ['Symbol|Security Name|ETF|Test Issue', ...rows, footer + '|||'].join('\n');
const other = rows => ['ACT Symbol|Security Name|Exchange|ETF|Test Issue', ...rows, footer + '||||'].join('\n');
const a = nasdaq(['AAA|Example Fund|Y|N', 'COMMON|Common Stock|N|N']);
const b = other(['BBB|Other Fund|P|Y|N']);
const fakeFetch = (left = a, right = b) => async url => new Response(String(url).includes('nasdaqlisted.txt') ? left : right);

test('directory row counts reconcile and unsupported listings remain explicitly visible', () => {
  const out = inspectNasdaqEtfDirectory(other(['BBB|Fund|P|Y|N', 'IEXF|IEX Fund|V|Y|N',
    'UNK|Unknown Fund|U|Y|N', 'TEST|Test Fund|P|Y|Y', 'LONGSYMBOL99|Long Fund|P|Y|N', 'COMMON|Stock|N|N|N']), 'other');
  assert.deepEqual(out.entries.map(row => row.symbol), ['BBB']);
  assert.equal(out.diagnostics.providerRows, 6); assert.equal(out.diagnostics.excludedRows, 5);
  assert.equal(Object.values(out.diagnostics.reasons).reduce((a, b) => a + b, 0), 6);
  assert.deepEqual(out.diagnostics.reasons, { accepted: 1, unsupported_listing: 1, unknown_exchange_code: 1,
    test_issue: 1, unsupported_symbol_format: 1, not_etf_flagged: 1 });
  assert.equal(out.rows.length, 6); assert.equal(out.diagnostics.footerComplete, true);
});

test('timezone-free source time stays local and invalid rollover dates cannot attest completeness', () => {
  const out = inspectNasdaqEtfDirectory(a, 'nasdaq');
  assert.equal(out.createdAt, null); assert.equal(out.creationTime.timeZone, null);
  assert.equal(out.creationTime.local, '2026-10-02T18:12:00');
  for (const invalid of ['0231202618:12', '1301202618:12', '1002202625:12']) {
    assert.equal(inspectNasdaqEtfDirectory(a.replace('1002202618:12', invalid), 'nasdaq').diagnostics.footerComplete, false);
  }
});

test('observed other-listed legacy trailer and documented TXSE code retain the five formerly invisible ETFs', () => {
  const text = ['ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
    ...['CTAG', 'ILS', 'OILT', 'PWRX', 'TXS'].map(symbol => `${symbol}|${symbol} Fund|F|${symbol}|Y|100|N|${symbol}`),
    footer + '||||||'].join('\n');
  const out = parseNasdaqEtfDirectory(text, 'other');
  assert.equal(out.entries.length, 5); assert.ok(out.entries.every(row => row.exchange === 'TXSE'));
  assert.equal(out.diagnostics.footerComplete, true); assert.equal(out.diagnostics.legacyOtherTrailer, true);
  assert.throws(() => parseNasdaqEtfDirectory(text.replace('||||||', '|||||'), 'other'), /terminal/);
});

test('truncated files, misplaced/duplicate/malformed footers and row widths fail production parsing', () => {
  const cases = [a.split('\n').slice(0, -1).join('\n'), a + '\nAFTER|Fund|Y|N', a + '\n' + footer + '|||',
    a.replace('|||', '||'), a.replace('AAA|Example Fund|Y|N', 'AAA|Fund|Y')];
  for (const text of cases) assert.throws(() => parseNasdaqEtfDirectory(text, 'nasdaq'), /terminal|malformed/);
  assert.throws(() => parseNasdaqEtfDirectory(a.replace('|Y|N', '|UNKNOWN|N'), 'nasdaq'), /malformed/);
});

test('identical duplicates are counted once but conflicting classifications and cross-file symbols fail closed', () => {
  const identical = inspectNasdaqEtfDirectory(nasdaq(['AAA|Fund|Y|N', 'AAA|Fund|Y|N']), 'nasdaq');
  assert.equal(identical.entries.length, 1); assert.equal(identical.diagnostics.reasons.duplicate_row, 1);
  const conflict = nasdaq(['AAA|Fund|Y|N', 'AAA|Fund|N|N']);
  const out = inspectNasdaqEtfDirectory(conflict, 'nasdaq');
  assert.equal(out.entries.length, 0); assert.equal(out.diagnostics.reasons.conflicting_symbol_rows, 2);
  assert.throws(() => parseNasdaqEtfDirectory(conflict, 'nasdaq'), /conflicting/);
  assert.throws(() => mergeEtfDirectories(a, other(['AAA|Fund|P|Y|N'])), /ambiguous/);
});

test('public probe makes exactly two uncredentialed GETs and does not claim account/price coverage', async () => {
  const calls = []; let tick = 0;
  const out = await probePublicEtfDirectory({ now: time, clock: () => tick++, fetcher: async (url, options) => {
    calls.push({ url, options }); return fakeFetch()(url);
  } });
  assert.equal(calls.length, 2); assert.ok(calls.every(row => new URL(row.url).hostname === 'www.nasdaqtrader.com'));
  assert.ok(calls.every(row => JSON.stringify(row.options.headers) === '{"accept":"text/plain"}'));
  assert.equal(out.report.status, 'directory_observed'); assert.equal(out.report.totalProviderRows, 3);
  assert.equal(out.report.completeAdapterUniverse, 2); assert.equal(out.report.accountTradable, null);
  assert.equal(out.report.activeInstruments, null); assert.equal(out.report.sourceAgeMs, null);
  assert.equal(out.report.priceScreened, 0); assert.equal(out.report.paperOrders, 0);
  assert.ok(out.sources.every(row => row.text && /^[a-f0-9]{64}$/.test(row.sha256)));
});

test('one failed file retains observed rows but unknown total coverage and cannot look like an empty successful scan', async () => {
  const out = await probePublicEtfDirectory({ now: time, fetcher: async url => String(url).includes('otherlisted') ? new Response('', { status: 403 }) : new Response(a) });
  assert.equal(out.report.status, 'directory_incomplete'); assert.equal(out.report.observedProviderRows, 2);
  assert.equal(out.report.totalProviderRows, null); assert.equal(out.report.completeAdapterUniverse, null);
  assert.equal(out.report.providerFailures, 1); assert.equal(out.report.providerRequests, 2);
});

test('successful HTTP with incomplete or conflicting directory data cannot attest complete enumeration', async () => {
  for (const text of [a.split('\n').slice(0, -1).join('\n'), nasdaq(['AAA|Fund|Y|N', 'AAA|Other fund|Y|N']), nasdaq([])]) {
    const out = await probePublicEtfDirectory({ now: time, fetcher: fakeFetch(text) });
    assert.equal(out.report.status, 'directory_incomplete'); assert.equal(out.report.completeAdapterUniverse, null);
  }
  const out = await probePublicEtfDirectory({ now: time, fetcher: fakeFetch(a, other(['AAA|Fund|P|Y|N'])) });
  assert.deepEqual(out.report.ambiguousCrossFileSymbols, ['AAA']); assert.equal(out.entries.length, 0);
});

test('oversized and malformed bodies produce bounded sanitized failures', async () => {
  const oversized = await probePublicEtfDirectory({ now: time, fetcher: async () => new Response('', { headers: { 'content-length': String(11 * 1024 * 1024) } }) });
  assert.equal(oversized.report.providerFailures, 2); assert.ok(oversized.sources.every(row => row.status === 'directory_body_too_large'));
  const malformed = await probePublicEtfDirectory({ now: time, fetcher: async () => new Response('<html>not a directory</html>') });
  assert.equal(malformed.report.status, 'directory_incomplete'); assert.ok(malformed.sources.every(row => row.status === 'directory_schema_failure'));
  const error = await probePublicEtfDirectory({ now: time, fetcher: async () => { throw new Error('secret transport payload'); } });
  assert.ok(!JSON.stringify(error).includes('secret transport payload'));
});

test('immutable artifact preserves every source and row disposition and can be written idempotently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-etf-public-'));
  try {
    const result = await probePublicEtfDirectory({ now: time, fetcher: fakeFetch() });
    const saved = await savePublicEtfDirectoryProbe(result, directory);
    assert.deepEqual(await savePublicEtfDirectoryProbe(result, directory), saved);
    const bytes = await readFile(join(directory, saved.file)), raw = gunzipSync(bytes);
    assert.equal(createHash('sha256').update(raw).digest('hex'), saved.uncompressedSha256);
    const content = JSON.parse(raw);
    assert.equal(content.sources[0].text, a); assert.equal(content.sources[0].inspection.rows.length, 2);
    assert.equal((await readdir(directory)).length, 1);
  } finally {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !directory.includes('omnimod-etf-public-')) throw new Error('Unsafe test cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});
