import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareFuturesDaySessionDraft } from '../src/prepareDaySessionDraft.js';
import { fingerprintFuturesDraft } from '../src/reviewedDaySession.js';

test('review CLI writes a separate runner input, leaves sources intact and refuses output overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-futures-review-cli-'));
  try {
    const now = Date.now();
    const expiry = new Date(now + 120 * 86_400_000).toISOString();
    const marketDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
    const definition = { product: 'E-mini S&P 500', providerSymbol: 'ES.v.0', providerRawSymbol: 'ESZ6', providerInstrumentId: '12345',
      providerPublisherId: '1', providerExchange: 'XCME', expiry, definitionTimestamp: new Date(now).toISOString() };
    const products = [{ symbol: 'E-mini S&P 500', providerSymbol: 'ES.v.0', assetClass: 'equity-index-future', underlying: 'S&P 500' }];
    const draft = prepareFuturesDaySessionDraft([definition], products, { now });
    const draftContents = `${JSON.stringify(draft, null, 2)}\n`;
    const draftPath = join(directory, 'draft.json'), reviewPath = join(directory, 'review.json');
    const outputPath = join(directory, 'day-session.json'), existingPath = join(directory, 'existing.json');
    const hash = fingerprintFuturesDraft(draftContents);
    const review = { schemaVersion: 1, draftSha256: hash, sessionDate: marketDate, approvals: [{ providerRawSymbol: 'ESZ6',
      contract: { contractId: 'XCME:12345', exposureKey: 'SPY', activeContract: true, contractSpecVerified: true, expiry,
        specSource: 'https://www.cmegroup.com/markets/equities/sp/e-mini-sandp500.contractSpecs.html', specVerifiedAt: new Date(now).toISOString(),
        tickSize: 0.25, tickValueUsd: 12.5, multiplier: 50, initialMarginUsd: 15_000, maintenanceMarginUsd: 13_500,
        settlementReview: { settlementType: 'cash_settled', source: 'https://www.cmegroup.com/markets/equities/sp/e-mini-sandp500.contractSpecs.html',
          reviewedAt: new Date(now).toISOString(), lastTradeAt: expiry } },
      session: { marketDate, timeZone: 'America/Chicago', openTime: `${marketDate}T16:00:00Z`, closeTime: `${marketDate}T19:00:00Z`,
        source: 'https://www.cmegroup.com/markets/equities/sp/e-mini-sandp500.calendar.html', reviewedAt: new Date(now).toISOString() },
      catalystReview: { status: 'clear', source: 'https://www.cmegroup.com/market-data/economic-calendar.html',
        summary: 'Current scheduled events reviewed.', reviewedAt: new Date(now).toISOString() },
      costs: { roundTripFeesPerContract: 4.5, slippageReservePerContract: 2 },
    }] };
    const reviewContents = `${JSON.stringify(review, null, 2)}\n`;
    await writeFile(draftPath, draftContents, { flag: 'wx' });
    await writeFile(reviewPath, reviewContents, { flag: 'wx' });
    const script = fileURLToPath(new URL('../scripts/compileReviewedDaySession.js', import.meta.url));
    const run = (output) => spawnSync(process.execPath, [script, draftPath, reviewPath, output], { encoding: 'utf8', timeout: 10_000 });
    const compiled = run(outputPath);
    assert.equal(compiled.status, 0, compiled.stderr);
    const result = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.equal(result.reviewCompilation.status, 'operator-reviewed-inputs');
    assert.equal(result.dayTrades[0].contract.contractId, 'XCME:12345');
    assert.deepEqual(result.dayTrades[0].bars, []);
    assert.equal(result.dayTrades[0].quote, null);
    assert.equal(await readFile(draftPath, 'utf8'), draftContents);
    assert.equal(await readFile(reviewPath, 'utf8'), reviewContents);

    await writeFile(existingPath, 'keep-existing-output\n', { flag: 'wx' });
    const overwrite = run(existingPath);
    assert.notEqual(overwrite.status, 0);
    assert.equal(await readFile(existingPath, 'utf8'), 'keep-existing-output\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
