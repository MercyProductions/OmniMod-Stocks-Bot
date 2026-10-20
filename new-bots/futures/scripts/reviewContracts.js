import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { reviewFuturesContractDefinitions } from '../src/contractReview.js';

const [definitionsPath, sessionPath] = process.argv.slice(2);
if (!definitionsPath || !sessionPath) {
  process.stderr.write('Usage: npm run review:contracts -- <definitions.json> <day-session.json>\n');
  process.exitCode = 2;
} else {
  const definitionsInput = JSON.parse(await readFile(resolve(definitionsPath), 'utf8'));
  const session = JSON.parse(await readFile(resolve(sessionPath), 'utf8'));
  const definitions = Array.isArray(definitionsInput) ? definitionsInput : definitionsInput.contracts;
  if (!Array.isArray(definitions) || !Array.isArray(session.dayTrades)) throw new Error('Expected provider contracts[] and session dayTrades[].');
  process.stdout.write(`${JSON.stringify(reviewFuturesContractDefinitions(definitions, session.dayTrades), null, 2)}\n`);
}
