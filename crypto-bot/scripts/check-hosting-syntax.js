import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const directory = new URL('../hosting/', import.meta.url);
const files = readdirSync(directory).filter((file) => file.endsWith('.js'));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(file, directory))], { stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
console.log(`Hosting JavaScript syntax checked: ${files.length} files.`);
