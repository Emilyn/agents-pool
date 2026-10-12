import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, hashPassword, loadMasterKey, verifyPassword } from '../src/platform/crypto.js';
import { JsonDb } from '../src/platform/db.js';
import { InProcessExecutor, JobQueue, containerName, dockerRunArgs, workerEnvNames } from '../src/platform/executor.js';
import { gitAuthEnv } from '../src/platform/repos.js';
import { detectHost } from '../src/host.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'agentpool-plat-'));

describe('secrets', () => {
  it('seals and opens values, and detects tampering or a different key', () => {
    const key = loadMasterKey(tmp(), {});
    const sealed = encrypt(key, 'ghp_token');
    expect(sealed).not.toContain('ghp_token');
    expect(decrypt(key, sealed)).toBe('ghp_token');
    expect(() => decrypt(loadMasterKey(tmp(), {}), sealed)).toThrow(/reconnected/);
    expect(() => decrypt(key, sealed.slice(0, -4) + 'AAAA')).toThrow();
  });
  it('keeps the generated key private and stable, or derives it from AGENTPOOL_SECRET', () => {
    const dir = tmp();
    const a = loadMasterKey(dir, {});
    expect(statSync(join(dir, 'secret.key')).mode & 0o777).toBe(0o600);
    expect(loadMasterKey(dir, {}).equals(a)).toBe(true);
    expect(loadMasterKey(tmp(), { AGENTPOOL_SECRET: 'a-long-enough-secret!' }).equals(loadMasterKey(tmp(), { AGENTPOOL_SECRET: 'a-long-enough-secret!' }))).toBe(true);
    expect(() => loadMasterKey(tmp(), { AGENTPOOL_SECRET: 'short' })).toThrow();
  });
  it('hashes passwords with a salt', async () => {
    const h1 = await hashPassword('correct horse');
    const h2 = await hashPassword('correct horse');
    expect(h1).not.toBe(h2);
    expect(await verifyPassword('correct horse', h1)).toBe(true);
    expect(await verifyPassword('wrong horse', h1)).toBe(false);
  });
  it('persists the database privately and atomically', () => {
    const dir = tmp();
    const db = new JsonDb(dir);
    db.update((d) => void d.users.push({ id: '1', name: 'a', passwordHash: 'x', role: 'admin', createdAt: '' }));
    expect(statSync(db.file).mode & 0o777).toBe(0o600);
    expect(new JsonDb(dir).data.users).toHaveLength(1);
    expect(JSON.parse(readFileSync(db.file, 'utf8')).repos).toEqual([]);
  });
});

describe('git credentials', () => {
  it('scopes the auth header to the host and uses the right username per provider', () => {
    const gh = gitAuthEnv(detectHost('https://github.com/a/b.git'), 'tok');
    expect(gh.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraHeader');
    expect(Buffer.from(gh.GIT_CONFIG_VALUE_0!.replace('Authorization: Basic ', ''), 'base64').toString()).toBe('x-access-token:tok');
    const gl = gitAuthEnv(detectHost('https://gitlab.com/g/p.git'), 'tok');
    expect(Buffer.from(gl.GIT_CONFIG_VALUE_0!.replace('Authorization: Basic ', ''), 'base64').toString()).toBe('oauth2:tok');
  });
});

describe('docker isolation settings', () => {
  const job = { runId: '20261012-101500-ab12', repoId: 'app-1', repoPath: '/srv/agentpool/repos/app-1/repo' };
  const env = { ANTHROPIC_API_KEY: 'sk-secret', GITHUB_TOKEN: 'ghp_x', JIRA_API_TOKEN: 'j', AGENTPOOL_SECRET: 'z', AGENTPOOL_WORKER_ENV: 'MY_PROXY_CA,bad name', MY_PROXY_CA: '/ca.pem' };
  const args = dockerRunArgs(job, { image: 'agentpool-worker', user: '1000:1000', network: 'agents', env });

  it('mounts only the repository clone and drops privileges', () => {
    expect(args.join(' ')).toContain(`-v ${job.repoPath}:${job.repoPath}`);
    expect(args.filter((a) => a === '-v')).toHaveLength(1);
    expect(args).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000', '--network', 'agents']));
    expect(args).toEqual(expect.arrayContaining(['--memory', '4g', '--cpus', '2', '--pids-limit', '512']));
    expect(args.slice(-5)).toEqual(['agentpool-worker', 'work', job.runId, '--repo', job.repoPath]);
    expect(args).toContain(containerName(job.runId));
  });
  it('passes the model key by name and never the repository, Jira or server secrets', () => {
    expect(workerEnvNames(env)).toEqual(['ANTHROPIC_API_KEY', 'MY_PROXY_CA']);
    const envFlags = args.flatMap((a, i) => (args[i - 1] === '-e' ? [a] : []));
    expect(envFlags).toEqual(['HOME=/tmp', 'ANTHROPIC_API_KEY', 'MY_PROXY_CA']);
    const joined = args.join(' ');
    expect(joined).not.toContain('sk-secret');
    expect(joined).not.toContain('GITHUB_TOKEN');
    expect(joined).not.toContain('JIRA_API_TOKEN');
    expect(joined).not.toContain('AGENTPOOL_SECRET');
  });
});

describe('job queue', () => {
  it('limits concurrency, runs one job per run, cancels queued and running jobs, and enforces the time limit', async () => {
    const order: string[] = [];
    const executor = new InProcessExecutor(async (job, signal) => {
      order.push(`start ${job.runId}`);
      await new Promise<void>((ok) => {
        const t = setTimeout(ok, 40);
        signal.addEventListener('abort', () => { clearTimeout(t); ok(); }, { once: true });
      });
    });
    const q = new JobQueue(executor, { concurrency: 1 });
    const done: Record<string, unknown> = {};
    const job = (id: string) => ({ runId: id, repoId: 'r', repoPath: '/x' });
    expect(q.enqueue(job('a'), (o) => void (done.a = o))).toBe(true);
    expect(q.enqueue(job('a'), () => undefined)).toBe(false);
    q.enqueue(job('b'), (o) => void (done.b = o));
    q.enqueue(job('c'), (o) => void (done.c = o));
    expect(q.state('a')).toBe('running');
    expect(q.state('b')).toBe('queued');
    expect(q.cancel('c')).toBe(true);
    await q.idle();
    expect(order).toEqual(['start a', 'start b']);
    expect(done.c).toBeUndefined();

    const slow = new JobQueue(new InProcessExecutor((_j, s) => new Promise<void>((ok) => s.addEventListener('abort', () => ok(), { once: true }))), { timeoutMs: 30 });
    let out: any;
    slow.enqueue(job('t'), (o) => void (out = o));
    await slow.idle();
    expect(out.killed).toBe('timeout');
  });
});
