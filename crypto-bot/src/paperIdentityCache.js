import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeCryptoExecutionIdentity, cryptoExecutionIdentityKey, cryptoIdentityRejection } from '../../new-bots/shared/cryptoExecutionIdentity.js';

const fail = code => { throw Object.assign(new Error(code), { code }); };
/** Only exact provider evidence is cached. Cache receipt time can never renew verifiedAt. */
export async function loadPaperPositionIdentity(raw, { directory, refresh, clock = Date.now, allowRefresh = true } = {}) {
  const id = normalizeCryptoExecutionIdentity(raw), key = cryptoExecutionIdentityKey(id);
  if (!id || Date.parse(id.verifiedAt) > clock() + 5000) return fail('invalid_saved_crypto_identity');
  if (id.quoteCurrency !== 'USD') return fail('crypto_quote_currency_conversion_required');
  if (!['Coinbase', 'Kraken'].includes(id.provider)) return fail('crypto_position_venue_unsupported');
  if (!cryptoIdentityRejection(id, clock())) return id;
  const file = join(directory, createHash('sha256').update(key).digest('hex') + '.json');
  let cached;
  try { cached = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') return fail('crypto_identity_cache_unreadable'); }
  if (cached) {
    if (cached.version !== 1 || cached.key !== key || cryptoExecutionIdentityKey(cached.identity) !== key)
      return fail('crypto_identity_cache_mismatch');
    if (!cryptoIdentityRejection(cached.identity, clock())) return normalizeCryptoExecutionIdentity(cached.identity);
    if (Date.parse(cached.identity.verifiedAt) > clock() + 5000) return fail('crypto_identity_cache_future');
  }
  if (!allowRefresh) return fail('crypto_identity_refresh_deferred');
  const refreshed = normalizeCryptoExecutionIdentity(await refresh(id));
  if (cryptoExecutionIdentityKey(refreshed) !== key || cryptoIdentityRejection(refreshed, clock()))
    return fail('crypto_identity_refresh_invalid');
  await mkdir(directory, { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ version: 1, key, identity: refreshed }) + '\n', { flag: 'wx' });
    await rename(temp, file);
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return refreshed;
}
