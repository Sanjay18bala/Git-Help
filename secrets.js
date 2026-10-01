import crypto from 'node:crypto';

// AES-256-GCM keyed by SESSION_SECRET: used for the session cookie and for API keys stored in the database.
// The key is derived on each call because .env is loaded after this module is imported.
const key = () => crypto.createHash('sha256').update(process.env.SESSION_SECRET ?? '').digest();

export function seal(data) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(data)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

export function unseal(str) {
  try {
    const b = Buffer.from(str, 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12), { authTagLength: 16 });
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]));
  } catch {
    return null;
  }
}
