import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

/**
 * The key that protects stored repository tokens. Either derived from AGENTPOOL_SECRET, or generated once
 * into `<data>/secret.key` (mode 0600). Losing it means stored tokens cannot be read and repos must be reconnected.
 */
export function loadMasterKey(dataDir: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const secret = env.AGENTPOOL_SECRET?.trim();
  if (secret) {
    if (secret.length < 16) throw new Error('AGENTPOOL_SECRET must be at least 16 characters.');
    return scryptSync(secret, 'agentpool-secret-v1', 32);
  }
  const file = join(dataDir, 'secret.key');
  if (existsSync(file)) {
    const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
    if (key.length !== 32) throw new Error(`${file} is not a valid key file.`);
    return key;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  chmodSync(file, 0o600);
  return key;
}

export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(key: Buffer, sealed: string): string {
  const [v, iv, tag, ct] = sealed.split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised sealed value');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  try {
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new Error('Could not decrypt a stored secret. The server key changed, so the repository must be reconnected.');
  }
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(pw, salt, 32)).toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), want.length);
  return got.length === want.length && timingSafeEqual(got, want);
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
