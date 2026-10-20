import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ignoredDirectories = new Set(['node_modules', '.git']);
const files = [];

function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) collect(path);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(path);
    }
  }
}

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
collect(workspaceRoot);
files.sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

process.stdout.write(`Syntax check passed for ${files.length} JavaScript files.\n`);
