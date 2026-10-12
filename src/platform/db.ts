import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Role = 'admin' | 'member';

export interface UserRecord {
  id: string;
  name: string;
  passwordHash: string;
  role: Role;
  disabled?: boolean;
  createdAt: string;
}

export interface SessionRecord {
  idHash: string;
  userId: string;
  csrf: string;
  expiresAt: number;
}

export interface RepoRecord {
  id: string;
  name: string;
  provider: 'github' | 'gitlab';
  hostname: string;
  project: string;
  /** Clone URL without credentials. */
  remoteUrl: string;
  webUrl: string;
  apiUrl: string;
  defaultBranch: string;
  canPush: boolean;
  tokenSealed: string;
  status: 'cloning' | 'ready' | 'error';
  error?: string;
  addedBy: string;
  createdAt: string;
  syncedAt?: string;
}

export interface TaskRecord {
  runId: string;
  repoId: string;
  createdBy: string;
  createdAt: string;
}

export interface DbShape {
  users: UserRecord[];
  sessions: SessionRecord[];
  repos: RepoRecord[];
  tasks: TaskRecord[];
}

/**
 * A small JSON file holding accounts, sessions, repositories and who started which task. One server process owns
 * it, so writes are whole-file and atomic (temp file, then rename). Run history lives in each repository's event
 * logs, not here.
 */
export class JsonDb {
  readonly file: string;
  data: DbShape;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'db.json');
    this.data = existsSync(this.file)
      ? { users: [], sessions: [], repos: [], tasks: [], ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<DbShape>) }
      : { users: [], sessions: [], repos: [], tasks: [] };
  }

  /** Apply a change and persist it. */
  update<T>(fn: (d: DbShape) => T): T {
    const out = fn(this.data);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
    return out;
  }
}
