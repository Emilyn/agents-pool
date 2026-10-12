import { randomUUID } from 'node:crypto';
import { hashPassword, randomToken, sha256, verifyPassword } from './crypto.js';
import type { JsonDb, Role, UserRecord } from './db.js';

const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 60_000;

export interface PublicUser {
  id: string;
  name: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
}

export const publicUser = (u: UserRecord): PublicUser => ({ id: u.id, name: u.name, role: u.role, disabled: Boolean(u.disabled), createdAt: u.createdAt });

export class AuthError extends Error {
  constructor(message: string, readonly status = 401) {
    super(message);
  }
}

/** Accounts, password login with a lockout after repeated failures, and server-side sessions. */
export class Accounts {
  private fails = new Map<string, { n: number; until: number }>();

  constructor(private readonly db: JsonDb, private readonly now: () => number = Date.now) {}

  hasUsers(): boolean {
    return this.db.data.users.length > 0;
  }

  list(): PublicUser[] {
    return this.db.data.users.map(publicUser);
  }

  byId(id: string): UserRecord | undefined {
    return this.db.data.users.find((u) => u.id === id);
  }

  async create(name: string, password: string, role: Role): Promise<PublicUser> {
    const clean = name.trim();
    if (!/^[A-Za-z0-9._-]{2,40}$/.test(clean)) throw new AuthError('Names are 2 to 40 letters, digits, dots, dashes or underscores.', 400);
    if (password.length < 10) throw new AuthError('Passwords need at least 10 characters.', 400);
    if (this.db.data.users.some((u) => u.name.toLowerCase() === clean.toLowerCase())) throw new AuthError(`A user called ${clean} already exists.`, 409);
    const user: UserRecord = { id: randomUUID(), name: clean, passwordHash: await hashPassword(password), role, createdAt: new Date(this.now()).toISOString() };
    this.db.update((d) => void d.users.push(user));
    return publicUser(user);
  }

  async setPassword(userId: string, password: string): Promise<void> {
    if (password.length < 10) throw new AuthError('Passwords need at least 10 characters.', 400);
    const hash = await hashPassword(password);
    this.db.update((d) => {
      const u = d.users.find((x) => x.id === userId);
      if (!u) throw new AuthError('No such user', 404);
      u.passwordHash = hash;
      d.sessions = d.sessions.filter((s) => s.userId !== userId);
    });
  }

  setDisabled(userId: string, disabled: boolean): void {
    this.db.update((d) => {
      const u = d.users.find((x) => x.id === userId);
      if (!u) throw new AuthError('No such user', 404);
      if (disabled && u.role === 'admin' && d.users.filter((x) => x.role === 'admin' && !x.disabled && x.id !== userId).length === 0) {
        throw new AuthError('You cannot disable the last admin.', 400);
      }
      u.disabled = disabled;
      if (disabled) d.sessions = d.sessions.filter((s) => s.userId !== userId);
    });
  }

  /** Check credentials. The same message is returned for an unknown user and a wrong password. */
  async login(name: string, password: string): Promise<{ token: string; csrf: string; user: PublicUser }> {
    const key = name.trim().toLowerCase();
    const f = this.fails.get(key);
    if (f && f.n >= MAX_FAILS && f.until > this.now()) throw new AuthError('Too many failed attempts. Try again in a minute.', 429);
    const user = this.db.data.users.find((u) => u.name.toLowerCase() === key);
    const ok = user ? await verifyPassword(password, user.passwordHash) : (await verifyPassword(password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='), false);
    if (!user || !ok || user.disabled) {
      const n = (f && f.until > this.now() ? f.n : 0) + 1;
      this.fails.set(key, { n, until: this.now() + LOCK_MS });
      throw new AuthError('Wrong name or password.');
    }
    this.fails.delete(key);
    const token = randomToken();
    const csrf = randomToken(16);
    this.db.update((d) => {
      d.sessions = d.sessions.filter((s) => s.expiresAt > this.now());
      d.sessions.push({ idHash: sha256(token), userId: user.id, csrf, expiresAt: this.now() + SESSION_MS });
    });
    return { token, csrf, user: publicUser(user) };
  }

  session(token: string | undefined): { user: PublicUser; csrf: string } | null {
    if (!token) return null;
    const h = sha256(token);
    const s = this.db.data.sessions.find((x) => x.idHash === h);
    if (!s || s.expiresAt <= this.now()) return null;
    const u = this.byId(s.userId);
    if (!u || u.disabled) return null;
    return { user: publicUser(u), csrf: s.csrf };
  }

  logout(token: string | undefined): void {
    if (!token) return;
    const h = sha256(token);
    this.db.update((d) => void (d.sessions = d.sessions.filter((s) => s.idHash !== h)));
  }

  static readonly sessionSeconds = SESSION_MS / 1000;
}
