import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const PRIMARY_BOTS = ['stocks', 'crypto'];

/** Read-only resolution for managed workers launched from their own project directories.
 * Do not import bot config: Crypto's dotenv import mutates the reporting process.
 */
export async function resolveOperatorDataLocations({ rootDir, overrides = {}, processEnv = process.env,
  platform = process.platform, homeDir = homedir() } = {}) {
  const result = {};
  for (const bot of PRIMARY_BOTS) {
    const projectRoot = resolve(rootDir, `../${bot}-bot`);
    const key = `OMNIMOD_${bot.toUpperCase()}_DATA_DIR`;
    let directory, source, relativeTo;
    if (overrides[bot] !== undefined && overrides[bot] !== null) {
      // Preserve the caller API: explicit relative arguments use the report cwd.
      directory = resolve(overrides[bot]);
      source = 'report-argument';
      relativeTo = 'report-working-directory';
    } else {
      let configured = processEnv[key];
      if (configured) source = 'process-environment';
      // Stocks explicitly falls through an empty environment value to its .env.
      // Crypto uses dotenv without override: an existing empty value masks .env.
      else if (bot === 'stocks' || !Object.hasOwn(processEnv, key)) {
        let local = {};
        try { local = parseEnv(await readFile(resolve(projectRoot, '.env'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        configured = local[key];
        if (configured) source = 'bot-env-file';
      }
      if (configured) {
        directory = resolve(projectRoot, configured);
        relativeTo = 'bot-working-directory';
      } else {
        directory = platform === 'win32' ? resolve(projectRoot, 'data') : resolve(homeDir, `.omnimod-${bot}-data`);
        source = platform === 'win32' ? 'project-default' : 'home-default';
        relativeTo = null;
      }
    }
    const directoryExists = await stat(directory).then(row => {
      if (!row.isDirectory()) throw new Error(`Expected ${bot} diagnostics location to be a directory.`);
      return true;
    }).catch(error => { if (error.code === 'ENOENT') return false; throw error; });
    result[bot] = { directory, diagnostic: { source, relativeTo, directoryExists,
      scope: 'Expected local data location; assumes the managed worker runs from its own bot project under this OS user. Separate worker environments, homes or working directories require an explicit report data-directory override. Paths and .env values are not returned.' } };
  }
  return result;
}
