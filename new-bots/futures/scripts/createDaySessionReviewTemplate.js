import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildFuturesDaySessionReviewTemplate, fingerprintFuturesDraft } from '../src/reviewedDaySession.js';

const [draftArg] = process.argv.slice(2);
if (!draftArg) {
  process.stderr.write('Usage: npm run template:day-session-review -- <draft.json>\n');
  process.stderr.write('Prints a review template with unset values; it does not approve or modify any Futures input.\n');
  process.exitCode = 2;
} else {
  const contents = await readFile(resolve(draftArg), 'utf8');
  const draft = JSON.parse(contents);
  process.stdout.write(`${JSON.stringify(buildFuturesDaySessionReviewTemplate(draft, fingerprintFuturesDraft(contents)), null, 2)}\n`);
}
