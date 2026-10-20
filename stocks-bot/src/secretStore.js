import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';

function key() {
  if (!config.configSecret || config.configSecret.length < 24) {
    throw new Error('STOCKS_CONFIG_SECRET must be set to at least 24 random characters before provider keys can be stored.');
  }
  return createHash('sha256').update(config.configSecret).digest();
}

export function encryptSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  const [version, iv, tag, payload] = text.split('.');
  if (version !== 'v1' || !iv || !tag || !payload) return '';
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(payload, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
