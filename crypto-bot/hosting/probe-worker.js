// Bounded, offline hosting preflight. Never imports a bot or makes network requests.
import { join } from 'node:path';
import { atomicJson, processIdentity, stateDir } from './common.js';
const nonce = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(nonce || '')) throw new Error('Invalid preflight nonce');
const identity = await processIdentity(process.pid);
await atomicJson(join(stateDir, `probe-${nonce}.json`), { processId: process.pid, startTicks: identity.startTicks });
process.once('SIGTERM', () => process.exit(0));
setTimeout(() => process.exit(1), 20000);
