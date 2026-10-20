// Isolate mock HTTP tests from operator state. Child worker fixtures inherit
// this directory unless they deliberately supply their own shared test budget.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';

if (/\.test\.[cm]?js$/.test(process.argv[1] || '')) {
  const root = resolve(tmpdir());
  const directory = mkdtempSync(join(root, 'omnimod-alpaca-test-'));
  process.env.ALPACA_SHARED_RATE_DIR = directory;
  process.env.TRADIER_SHARED_RATE_DIR = join(directory, 'tradier');
  process.env.ALPACA_REQUESTS_PER_MINUTE = '10000';
  process.env.ALPACA_RATE_LIMIT_GROUP = '';
  process.once('exit', () => {
    const child = relative(root, resolve(directory));
    if (child && !child.startsWith('..') && !isAbsolute(child)) rmSync(directory, { recursive: true, force: true });
  });
}
