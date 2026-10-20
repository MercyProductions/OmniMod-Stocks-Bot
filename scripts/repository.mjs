import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'repository.json'), 'utf8'));
const action = process.argv[2];
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this command through npm run.');
function npm(directory, args) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd: resolve(root, directory),
    stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (action === 'info') {
  console.log(JSON.stringify({ bot: manifest.bot, project: manifest.primaryProject,
    startScript: JSON.parse(readFileSync(resolve(root, manifest.primaryProject, 'package.json'), 'utf8')).scripts.start,
    snapshot: manifest.snapshotDate, liveOrders: 'disabled; paper research only' }, null, 2));
} else if (action === 'bootstrap') {
  for (const directory of ['new-bots', 'stocks-bot', 'crypto-bot'])
    npm(directory, ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
} else if (action === 'test:all' || action === 'check') {
  for (const directory of ['new-bots', 'stocks-bot', 'crypto-bot'])
    npm(directory, ['run', action === 'check' ? 'check' : 'test']);
} else if (action === 'report') {
  npm('new-bots', ['run', 'report:operator']);
} else if (['start', 'test', 'register'].includes(action)) {
  npm(manifest.primaryProject, ['run', action, ...process.argv.slice(3)]);
} else {
  throw new Error('Unknown repository command.');
}
