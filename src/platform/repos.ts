import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { git, isGitRepo } from '../git.js';
import { createClient, detectHost, inspectRepo, type FetchLike, type HostClient, type HostKind, type HostRef } from '../host.js';
import { decrypt, encrypt } from './crypto.js';
import type { JsonDb, RepoRecord } from './db.js';

/** What the HTTP layer and the executors need from a repository, whether connected or local. */
export interface RepoView {
  id: string;
  name: string;
  provider?: 'github' | 'gitlab';
  project?: string;
  webUrl?: string;
  defaultBranch?: string;
  status: 'cloning' | 'ready' | 'error';
  error?: string;
  canPush?: boolean;
  local?: boolean;
  syncedAt?: string;
}

export interface RepoProvider {
  list(): RepoView[];
  view(id: string): RepoView | undefined;
  /** Directory of the git checkout the runs live in. */
  pathFor(id: string): string;
  /** Bring the checkout up to date and say which ref and branch name a new task starts from. */
  prepare(id: string, baseBranch?: string): Promise<{ base?: string; baseBranch?: string }>;
  /** Credentials for pushing and opening the request. Never handed to agents or containers. */
  publishDeps(id: string): { client?: HostClient; gitEnv?: NodeJS.ProcessEnv };
}

export interface RegistryOptions {
  dataDir: string;
  db: JsonDb;
  key: Buffer;
  fetchImpl?: FetchLike;
  gitName?: string;
  gitEmail?: string;
  /** Tests map a public URL onto a local bare repository. */
  cloneUrlFor?: (ref: HostRef, remoteUrl: string) => string;
}

export class RepoError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** Credentials for git over HTTPS, passed through the environment so they never reach .git/config or `ps`. */
export function gitAuthEnv(ref: HostRef, token: string): NodeJS.ProcessEnv {
  const user = ref.kind === 'github' ? 'x-access-token' : 'oauth2';
  const basic = Buffer.from(`${user}:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${ref.webUrl}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

/** Connected repositories: a token per repo, kept encrypted, and a server-side clone that tasks branch from. */
export class RepoRegistry implements RepoProvider {
  private cloning = new Map<string, Promise<void>>();
  private fetchImpl: FetchLike;

  constructor(private readonly o: RegistryOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
    // A restart can interrupt a clone. Mark it so the person can retry rather than waiting forever.
    o.db.update((d) => {
      for (const r of d.repos) if (r.status === 'cloning') Object.assign(r, { status: 'error', error: 'The server restarted while cloning. Use Sync to try again.' });
    });
  }

  private rec(id: string): RepoRecord {
    const r = this.o.db.data.repos.find((x) => x.id === id);
    if (!r) throw new RepoError(`No repository ${id}`, 404);
    return r;
  }

  private toView = (r: RepoRecord): RepoView => ({
    id: r.id, name: r.name, provider: r.provider, project: r.project, webUrl: `${r.webUrl}/${r.project}`, defaultBranch: r.defaultBranch,
    status: r.status, error: r.error, canPush: r.canPush, syncedAt: r.syncedAt,
  });

  list(): RepoView[] {
    return this.o.db.data.repos.map(this.toView);
  }

  view(id: string): RepoView | undefined {
    const r = this.o.db.data.repos.find((x) => x.id === id);
    return r ? this.toView(r) : undefined;
  }

  pathFor(id: string): string {
    this.rec(id);
    return join(this.o.dataDir, 'repos', id, 'repo');
  }

  private token(r: RepoRecord): string {
    return decrypt(this.o.key, r.tokenSealed);
  }

  private ref(r: RepoRecord): HostRef {
    return { kind: r.provider, hostname: r.hostname, webUrl: r.webUrl, apiUrl: r.apiUrl, project: r.project };
  }

  publishDeps(id: string): { client?: HostClient; gitEnv?: NodeJS.ProcessEnv } {
    const r = this.rec(id);
    const token = this.token(r);
    return { client: createClient(this.ref(r), token, this.fetchImpl), gitEnv: gitAuthEnv(this.ref(r), token) };
  }

  /** Validate the token against the host, store it sealed, and start cloning in the background. */
  async add(input: { url: string; token: string; userId: string; host?: HostKind; apiUrl?: string }): Promise<RepoView> {
    const token = input.token.trim();
    if (!token) throw new RepoError('A token is required.');
    let ref: HostRef;
    try {
      ref = detectHost(input.url, { host: input.host, apiUrl: input.apiUrl });
    } catch (e) {
      throw new RepoError((e as Error).message);
    }
    if (this.o.db.data.repos.some((r) => r.hostname === ref.hostname && r.project.toLowerCase() === ref.project.toLowerCase())) {
      throw new RepoError(`${ref.project} on ${ref.hostname} is already connected.`, 409);
    }
    let info;
    try {
      info = await inspectRepo(ref, token, this.fetchImpl);
    } catch (e) {
      throw new RepoError((e as Error).message, 400);
    }
    const id = `${slug(ref.project.split('/').pop() ?? 'repo')}-${randomUUID().slice(0, 6)}`;
    const remoteUrl = `${ref.webUrl}/${ref.project}.git`;
    const record: RepoRecord = {
      id, name: ref.project, provider: ref.kind, hostname: ref.hostname, project: ref.project, remoteUrl, webUrl: ref.webUrl, apiUrl: ref.apiUrl,
      defaultBranch: info.defaultBranch, canPush: info.canPush, tokenSealed: encrypt(this.o.key, token), status: 'cloning',
      addedBy: input.userId, createdAt: new Date().toISOString(),
    };
    this.o.db.update((d) => void d.repos.push(record));
    this.startClone(id);
    return this.toView(record);
  }

  /** Resolves when any clone in progress has finished (used by tests and shutdown). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.cloning.values()]);
  }

  private startClone(id: string): void {
    const job = (async () => {
      const r = this.rec(id);
      const ref = this.ref(r);
      const dir = join(this.o.dataDir, 'repos', id);
      try {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const url = this.o.cloneUrlFor ? this.o.cloneUrlFor(ref, r.remoteUrl) : r.remoteUrl;
        const env = url.startsWith('http') ? gitAuthEnv(ref, this.token(r)) : undefined;
        await git(dir, ['clone', '--quiet', url, 'repo'], env);
        const repo = join(dir, 'repo');
        await git(repo, ['config', 'user.name', this.o.gitName ?? 'agentpool']);
        await git(repo, ['config', 'user.email', this.o.gitEmail ?? 'agentpool@localhost']);
        await git(repo, ['config', 'gc.auto', '0']);
        this.o.db.update(() => Object.assign(r, { status: 'ready', error: undefined, syncedAt: new Date().toISOString() }));
      } catch (e) {
        this.o.db.update(() => Object.assign(r, { status: 'error', error: (e as Error).message.replace(/Authorization: Basic \S+/g, 'Authorization: ***') }));
      } finally {
        this.cloning.delete(id);
      }
    })();
    this.cloning.set(id, job);
  }

  /** Re-clone after a failure. */
  retry(id: string): void {
    const r = this.rec(id);
    if (r.status === 'cloning') throw new RepoError('Already cloning.', 409);
    this.o.db.update(() => Object.assign(r, { status: 'cloning', error: undefined }));
    this.startClone(id);
  }

  async prepare(id: string, baseBranch?: string): Promise<{ base: string; baseBranch: string }> {
    const r = this.rec(id);
    if (r.status !== 'ready') throw new RepoError(r.status === 'cloning' ? 'The repository is still being cloned.' : `The repository is not usable: ${r.error ?? 'clone failed'}`, 409);
    const dir = this.pathFor(id);
    if (!(await isGitRepo(dir))) throw new RepoError('The server copy of the repository is missing. Use Sync to clone it again.', 409);
    const env = this.o.cloneUrlFor && !this.o.cloneUrlFor(this.ref(r), r.remoteUrl).startsWith('http') ? undefined : gitAuthEnv(this.ref(r), this.token(r));
    try {
      await git(dir, ['fetch', '--quiet', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'], env);
    } catch (e) {
      throw new RepoError(`Could not fetch from ${r.hostname}: ${(e as Error).message.replace(/Authorization: Basic \S+/g, 'Authorization: ***')}`, 502);
    }
    const name = (baseBranch ?? '').trim() || r.defaultBranch;
    if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith('-') || name.includes('..')) throw new RepoError(`"${name}" is not a valid branch name.`);
    try {
      await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]);
    } catch {
      throw new RepoError(`Branch "${name}" does not exist on ${r.hostname}.`);
    }
    // Keep the clone's own checkout on the default branch tip: that is where .agentpool/config.json and any
    // repo-specific agents are read from. Nobody edits this checkout; tasks work in separate worktrees.
    try {
      await git(dir, ['checkout', '--quiet', '--detach', '--force', `origin/${r.defaultBranch}`]);
    } catch {
      /* the default branch may have been renamed; the task can still start from the requested base */
    }
    this.o.db.update(() => void (r.syncedAt = new Date().toISOString()));
    return { base: `origin/${name}`, baseBranch: name };
  }

  /** Remove a repository, its secrets and its server-side clone. The caller makes sure nothing is running. */
  remove(id: string): void {
    this.rec(id);
    this.o.db.update((d) => {
      d.repos = d.repos.filter((r) => r.id !== id);
      d.tasks = d.tasks.filter((t) => t.repoId !== id);
    });
    const dir = join(this.o.dataDir, 'repos', id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

/** The single working copy behind `agentpool serve`: no tokens stored, credentials come from the environment. */
export class LocalRepo implements RepoProvider {
  constructor(private readonly root: string, private readonly name = 'this repository') {}
  list(): RepoView[] {
    return [this.view('local')!];
  }
  view(id: string): RepoView | undefined {
    return id === 'local' ? { id: 'local', name: this.name, status: 'ready', local: true } : undefined;
  }
  pathFor(): string {
    return this.root;
  }
  async prepare(_id: string, baseBranch?: string): Promise<{ base?: string; baseBranch?: string }> {
    return baseBranch ? { base: baseBranch } : {};
  }
  publishDeps(): Record<string, never> {
    return {};
  }
}
