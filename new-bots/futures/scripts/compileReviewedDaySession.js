import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compileReviewedFuturesDaySession, fingerprintFuturesDraft } from '../src/reviewedDaySession.js';

const [draftArg, reviewArg, outputArg] = process.argv.slice(2);
if (!draftArg || !reviewArg || !outputArg) {
  process.stderr.write('Usage: npm run compile:day-session-review -- <draft.json> <review.json> <new-output.json>\n');
  process.stderr.write('Requires a matching SHA-256 draft fingerprint and current source-cited contract, session, catalyst, settlement, and cost reviews. The output is paper-only.\n');
  process.exitCode = 2;
} else {
  const draftPath = resolve(draftArg), reviewPath = resolve(reviewArg), outputPath = resolve(outputArg);
  if (draftPath === outputPath || reviewPath === outputPath) throw new Error('Output must be a separate file; draft and review inputs are never overwritten.');
  const draftContents = await readFile(draftPath, 'utf8');
  const reviewContents = await readFile(reviewPath, 'utf8');
  const output = compileReviewedFuturesDaySession(JSON.parse(draftContents), JSON.parse(reviewContents), {
    draftSha256: fingerprintFuturesDraft(draftContents),
  });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ status: output.reviewCompilation.status, reviewedRows: output.dayTrades.length,
    outputPath, paperOnly: true, liveTradingEnabled: false }, null, 2)}\n`);
}
