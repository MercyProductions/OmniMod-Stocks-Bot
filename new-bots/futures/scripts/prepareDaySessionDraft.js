import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareFuturesDaySessionDraft } from '../src/prepareDaySessionDraft.js';

const [definitionsPath, productsPath = 'examples/futures.json'] = process.argv.slice(2);
if (!definitionsPath) {
  process.stderr.write('Usage: npm run prepare:day-session -- <definitions.json> [products.json]\n');
  process.stderr.write('Reads provider definitions and prints an unverified review draft to stdout; it does not edit source files.\n');
  process.exitCode = 2;
} else {
  const definitionsInput = JSON.parse(await readFile(resolve(definitionsPath), 'utf8'));
  const products = JSON.parse(await readFile(resolve(productsPath), 'utf8'));
  const definitions = Array.isArray(definitionsInput) ? definitionsInput : definitionsInput.contracts;
  if (!Array.isArray(definitions)) throw new Error('Expected an array of dated Futures provider definitions.');
  const draft = prepareFuturesDaySessionDraft(definitions, products);
  process.stdout.write(`${JSON.stringify(draft, null, 2)}\n`);
  if (draft.rejectedDefinitions.length) {
    process.stderr.write(`Prepared ${draft.draftedDefinitions} unverified draft row(s); rejected ${draft.rejectedDefinitions.length} definition(s). Inspect rejectedDefinitions before review.\n`);
    process.exitCode = 1;
  }
}
