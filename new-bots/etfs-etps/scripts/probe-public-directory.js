import { fileURLToPath } from 'node:url';
import { probePublicEtfDirectory, savePublicEtfDirectoryProbe } from '../src/publicDirectoryProbe.js';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output-dir' || !args[1].trim())) throw new Error('Use no arguments or --output-dir <directory>.');
const outputDirectory = args[1] || fileURLToPath(new URL('../data/public-directory-probe/', import.meta.url));
const result = await probePublicEtfDirectory();
const artifact = await savePublicEtfDirectoryProbe(result, outputDirectory);
console.log(JSON.stringify({ ...result.report, artifact }, null, 2));
if (result.report.status !== 'directory_observed') process.exitCode = 1;
