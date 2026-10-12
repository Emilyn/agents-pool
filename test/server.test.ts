import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Accounts } from '../src/platform/accounts.js';
import { loadMasterKey } from '../src/platform/crypto.js';
import { JsonDb } from '../src/platform/db.js';
import { InProcessExecutor, LocalExecutor, type Executor } from '../src/platform/executor.js';
import { PACKAGE_ROOT } from '../src/config.js';
import { LocalRepo, RepoRegistry } from '../src/platform/repos.js';
import { DryRunRunner } from '../src/runner.js';
import { inProcessExecutor, startServer, type RunningServer } from '../src/server.js';
import { makeRepo } from './helpers.js';

const TOKEN = 'ghp_supersecrettoken1234567890';
let running: RunningServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

const wait = async <T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> => {
  for (let i = 0; i < 150; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};

function client(base: string) {
  let cookie = '';
  let csrf = '';
  const call = async (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...extra };
    if (cookie) headers.cookie = cookie;
    if (csrf && !('x-agentpool-csrf' in extra)) headers['x-agentpool-csrf'] = csrf;
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!.endsWith('=') ? '' : set.split(';')[0]!;
    const json = (await res.json().catch(() => ({}))) as any;
    if (json?.csrf) csrf = json.csrf;
    return { status: res.status, json, setCookie: set };
  };
  return { call, forget: () => { cookie = ''; csrf = ''; } };
}

/** A team server over a real local bare repository standing in for GitHub. */
async function team(over: { executor?: Executor; maxBudgetUsd?: number } = {}) {
  const origin = makeRepo({ 'README.md': '# app\n', 'src/a.txt': 'a\n' });
  const bare = mkdtempSync(join(tmpdir(), 'agentpool-origin-'));
  execFileSync('git', ['clone', '-q', '--bare', origin, bare]);
  const dataDir = mkdtempSync(join(tmpdir(), 'agentpool-data-'));
  const db = new JsonDb(dataDir);
  const accounts = new Accounts(db);
  const apiCalls: { url: string; method: string; body: any; auth: string }[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    apiCalls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization ?? '' });
    if (url.endsWith('/repos/acme/app')) return new Response(JSON.stringify({ default_branch: 'main', private: true, permissions: { push: true } }), { status: 200 });
    if (url.endsWith('/repos/acme/app/pulls') && init.method === 'POST') return new Response(JSON.stringify({ html_url: 'https://github.com/acme/app/pull/12', number: 12 }), { status: 201 });
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  };
  const registry = new RepoRegistry({ dataDir, db, key: loadMasterKey(dataDir, {}), fetchImpl, cloneUrlFor: () => bare });
  const executor = over.executor ?? inProcessExecutor({ runnerFor: () => new DryRunRunner() });
  running = await startServer({ repos: registry, registry, accounts, executor, port: 0, fetchImpl, maxBudgetUsd: over.maxBudgetUsd, env: {} });
  const base = running.url.replace(/\/$/, '');
  return { base, bare, dataDir, db, registry, apiCalls, admin: client(base), origin };
}

async function setupAdmin(t: Awaited<ReturnType<typeof team>>) {
  const r = await t.admin.call('/api/setup', 'POST', { name: 'ada', password: 'correct horse battery' });
  expect(r.status).toBe(200);
}

async function connect(t: Awaited<ReturnType<typeof team>>) {
  const r = await t.admin.call('/api/repos', 'POST', { url: 'https://github.com/acme/app', token: TOKEN });
  expect(r.status).toBe(201);
  const rid = r.json.id as string;
  await wait(() => t.admin.call('/api/repos'), (v) => v.json.repos[0]?.status === 'ready', 'clone');
  return rid;
}

describe('accounts and sessions', () => {
  it('requires first-run setup, then login, and protects every API call', async () => {
    const t = await team();
    expect((await t.admin.call('/api/me')).json).toMatchObject({ user: null, setupNeeded: true, mode: 'team' });
    expect((await t.admin.call('/api/repos')).status).toBe(401);
    expect((await t.admin.call('/api/setup', 'POST', { name: 'ada', password: 'short' })).status).toBe(400);
    const ok = await t.admin.call('/api/setup', 'POST', { name: 'ada', password: 'correct horse battery' });
    expect(ok.status).toBe(200);
    expect(ok.setCookie).toMatch(/HttpOnly/);
    expect(ok.setCookie).toMatch(/SameSite=Strict/);
    expect((await t.admin.call('/api/setup', 'POST', { name: 'eve', password: 'another long password' })).status).toBe(409);
    expect((await t.admin.call('/api/me')).json.user).toMatchObject({ name: 'ada', role: 'admin' });
    expect(readFileSync(t.db.file, 'utf8')).not.toContain('correct horse');
  });

  it('rejects wrong passwords, locks out repeated failures, and ends sessions on logout', async () => {
    const t = await team();
    await setupAdmin(t);
    const c = client(t.base);
    expect((await c.call('/api/login', 'POST', { name: 'ada', password: 'nope nope nope' })).status).toBe(401);
    expect((await c.call('/api/login', 'POST', { name: 'nobody', password: 'nope nope nope' })).json.error).toBe('Wrong name or password.');
    for (let i = 0; i < 4; i++) await c.call('/api/login', 'POST', { name: 'ada', password: 'bad bad bad bad' });
    expect((await c.call('/api/login', 'POST', { name: 'ada', password: 'correct horse battery' })).status).toBe(429);
    await t.admin.call('/api/logout', 'POST', {});
    expect((await t.admin.call('/api/repos')).status).toBe(401);
  });

  it('needs the CSRF header and a same-origin request for every write', async () => {
    const t = await team();
    await setupAdmin(t);
    expect((await t.admin.call('/api/users', 'POST', { name: 'bob', password: 'bobs long password' }, { 'x-agentpool-csrf': 'wrong' })).status).toBe(403);
    expect((await t.admin.call('/api/users', 'POST', { name: 'bob', password: 'bobs long password' }, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await t.admin.call('/api/users', 'POST', { name: 'bob', password: 'bobs long password' })).status).toBe(201);
  });

  it('lets admins manage users and keeps members out of admin routes', async () => {
    const t = await team();
    await setupAdmin(t);
    await t.admin.call('/api/users', 'POST', { name: 'bob', password: 'bobs long password', role: 'member' });
    const bob = client(t.base);
    expect((await bob.call('/api/login', 'POST', { name: 'bob', password: 'bobs long password' })).status).toBe(200);
    expect((await bob.call('/api/users')).status).toBe(403);
    const users = (await t.admin.call('/api/users')).json.users as any[];
    const id = users.find((u) => u.name === 'bob').id;
    expect((await t.admin.call(`/api/users/${id}/disable`, 'POST', {})).status).toBe(200);
    expect((await bob.call('/api/repos')).status).toBe(401);
    expect((await client(t.base).call('/api/login', 'POST', { name: 'bob', password: 'bobs long password' })).status).toBe(401);
    const adminId = users.find((u) => u.name === 'ada').id;
    expect((await t.admin.call(`/api/users/${adminId}/disable`, 'POST', {})).status).toBe(400);
  });
});

describe('connecting a repository', () => {
  it('validates the token, keeps it sealed, clones, and never returns the token', async () => {
    const t = await team();
    await setupAdmin(t);
    const bad = await t.admin.call('/api/repos', 'POST', { url: 'https://github.com/acme/missing', token: TOKEN });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/not found/);
    const rid = await connect(t);
    const list = JSON.stringify((await t.admin.call('/api/repos')).json);
    expect(list).not.toContain(TOKEN);
    expect(list).toContain('"defaultBranch":"main"');
    expect(readFileSync(t.db.file, 'utf8')).not.toContain(TOKEN);
    expect(readFileSync(join(t.dataDir, 'secret.key'), 'utf8')).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(t.dataDir, 'repos', rid, 'repo', '.git'))).toBe(true);
    // The token header is sent to the API with the right scheme.
    expect(t.apiCalls[0]?.auth).toBe(`Bearer ${TOKEN}`);
    expect((await t.admin.call('/api/repos', 'POST', { url: 'https://github.com/acme/app', token: TOKEN })).status).toBe(409);
  });

  it('lets only an admin remove a repository and deletes its clone', async () => {
    const t = await team();
    await setupAdmin(t);
    const rid = await connect(t);
    await t.admin.call('/api/users', 'POST', { name: 'bob', password: 'bobs long password' });
    const bob = client(t.base);
    await bob.call('/api/login', 'POST', { name: 'bob', password: 'bobs long password' });
    expect((await bob.call(`/api/repos/${rid}`, 'DELETE')).status).toBe(403);
    expect((await t.admin.call(`/api/repos/${rid}`, 'DELETE')).status).toBe(200);
    expect(existsSync(join(t.dataDir, 'repos', rid))).toBe(false);
    expect((await t.admin.call(`/api/repos/${rid}`)).status).toBe(404);
  });
});

describe('tasks in a connected repository', () => {
  it('runs a task end to end, attributes it to the person, and opens the pull request with the stored token', async () => {
    const t = await team();
    await setupAdmin(t);
    const rid = await connect(t);
    const started = await t.admin.call(`/api/repos/${rid}/runs`, 'POST', { task: 'Anything [ask]', runner: 'dry-run', skipBaseline: true });
    expect(started.status).toBe(201);
    const id = started.json.id as string;
    const run = (q = '') => t.admin.call(`/api/repos/${rid}/runs/${id}${q}`);

    const asked = await wait(run, (v) => v.json.state.phase === 'awaiting_answers' && !v.json.working, 'question');
    expect(asked.json.state.createdBy).toBe('ada');
    expect(asked.json.state.baseBranch).toBe('main');
    const q = asked.json.state.questions[0];
    expect((await t.admin.call(`/api/repos/${rid}/runs/${id}/answer`, 'POST', { questionId: q.id, answer: '' })).status).toBe(400);
    expect((await t.admin.call(`/api/repos/${rid}/runs/${id}/answer`, 'POST', { questionId: q.id, answer: 'bullets' })).status).toBe(200);
    await wait(run, (v) => v.json.state.phase === 'awaiting_plan_approval' && !v.json.working, 'plan');
    expect((await t.admin.call(`/api/repos/${rid}/runs/${id}/approve`, 'POST', {})).json.gate).toBe('plan');
    const done = await wait(run, (v) => v.json.state.phase === 'done' && !v.json.working, 'done');
    expect(done.json.mr).toContain('Status:');

    const answered = done.json.state.decisions[0];
    expect(answered.answer).toBe('bullets');
    const events = (await run()).json.events as any[];
    expect(events.find((e) => e.type === 'question.answered').actor).toMatchObject({ type: 'human', id: 'ada' });

    // Open the pull request: pushed to the "remote" and created through the API with the stored token.
    const pr = await t.admin.call(`/api/repos/${rid}/runs/${id}/pr`, 'POST', {});
    expect(pr.status).toBe(200);
    expect(pr.json.url).toBe('https://github.com/acme/app/pull/12');
    expect(execFileSync('git', ['branch', '--list', `agentpool/${id}`], { cwd: t.bare }).toString()).toContain(id);
    const created = t.apiCalls.find((c) => c.method === 'POST' && c.url.endsWith('/pulls'))!;
    expect(created.auth).toBe(`Bearer ${TOKEN}`);
    expect(created.body).toMatchObject({ base: 'main', head: `agentpool/${id}` });
    expect((await run()).json.state.pr.number).toBe(12);

    const list = (await t.admin.call(`/api/repos/${rid}/runs`)).json.runs as any[];
    expect(list[0]).toMatchObject({ id, phase: 'done', createdBy: 'ada', pr: 'https://github.com/acme/app/pull/12' });
  });

  it('picks up new commits on the remote and lets a task start from another branch', async () => {
    const t = await team();
    await setupAdmin(t);
    const rid = await connect(t);
    execFileSync('git', ['branch', 'release', 'main'], { cwd: t.bare });
    // A new commit (here a repo-level config file) lands on the remote after the clone was made.
    const pusher = mkdtempSync(join(tmpdir(), 'agentpool-push-'));
    execFileSync('git', ['clone', '-q', t.bare, pusher]);
    writeFileSync(join(pusher, 'new.txt'), 'hello\n');
    execFileSync('git', ['add', '-A'], { cwd: pusher });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'later'], { cwd: pusher });
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: pusher });
    const want = execFileSync('git', ['rev-parse', 'main'], { cwd: t.bare }).toString().trim();
    const nope = await t.admin.call(`/api/repos/${rid}/runs`, 'POST', { task: 'x', runner: 'dry-run', base: 'ghost' });
    expect(nope.status).toBe(400);
    expect(nope.json.error).toMatch(/does not exist/);
    const bad = await t.admin.call(`/api/repos/${rid}/runs`, 'POST', { task: 'x', runner: 'dry-run', base: '--upload-pack=evil' });
    expect(bad.status).toBe(400);
    const r = await t.admin.call(`/api/repos/${rid}/runs`, 'POST', { task: 'On release', runner: 'dry-run', base: 'release', skipBaseline: true, autonomy: 'auto' });
    expect(r.status).toBe(201);
    const v = await wait(() => t.admin.call(`/api/repos/${rid}/runs/${r.json.id}`), (x) => x.json.state.phase === 'done' && !x.json.working, 'done');
    expect(v.json.state.baseBranch).toBe('release');
    // The clone's own checkout followed the default branch, so repo config is read from the latest commit.
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(t.dataDir, 'repos', rid, 'repo') }).toString().trim();
    expect(head).toBe(want);
    expect(existsSync(join(t.dataDir, 'repos', rid, 'repo', 'new.txt'))).toBe(true);
  });

  it('caps the budget a task can ask for', async () => {
    const t = await team({ maxBudgetUsd: 2 });
    await setupAdmin(t);
    const rid = await connect(t);
    const r = await t.admin.call(`/api/repos/${rid}/runs`, 'POST', { task: 'x', runner: 'dry-run', budgetUsd: 500, skipBaseline: true });
    const v = await t.admin.call(`/api/repos/${rid}/runs/${r.json.id}`);
    expect(v.json.state.options.budgetUsd).toBe(2);
  });

  it('can stop a running task and resume it later', async () => {
    let started!: () => void;
    const gate = new Promise<void>((ok) => (started = ok));
    const executor = new InProcessExecutor(async (_job, signal) => {
      started();
      await new Promise<void>((ok) => signal.addEventListener('abort', () => ok(), { once: true }));
    });
    const t = await team({ executor });
    await setupAdmin(t);
    const rid = await connect(t);
    const r = await t.admin.call(`/api/repos/${rid}/runs`, 'POST', { task: 'Long one', runner: 'dry-run' });
    await gate;
    const id = r.json.id;
    expect((await t.admin.call(`/api/repos/${rid}/runs/${id}`)).json.job).toBe('running');
    expect((await t.admin.call(`/api/repos/${rid}/runs/${id}/resume`, 'POST', {})).status).toBe(409);
    expect((await t.admin.call(`/api/repos/${rid}/runs/${id}/cancel`, 'POST', {})).status).toBe(200);
    const stopped = await wait(() => t.admin.call(`/api/repos/${rid}/runs/${id}`), (v) => !v.json.working, 'stop');
    expect(stopped.json.state.lastError).toMatch(/Stopped by ada/);
    expect((await t.admin.call(`/api/repos/${rid}/runs/${id}/cancel`, 'POST', {})).status).toBe(409);
  });

  it('does not let one repository read another repository\'s runs', async () => {
    const t = await team();
    await setupAdmin(t);
    const rid = await connect(t);
    const r = await t.admin.call(`/api/repos/${rid}/runs`, 'POST', { task: 'x', runner: 'dry-run', skipBaseline: true, autonomy: 'auto' });
    expect((await t.admin.call(`/api/repos/not-a-repo/runs/${r.json.id}`)).status).toBe(404);
  });
});

describe.skipIf(!existsSync(join(PACKAGE_ROOT, 'dist', 'cli.js')))('worker process', () => {
  it('runs a task in a separate worker process, then the server opens the PR', async () => {
    const t = await team({ executor: new LocalExecutor() });
    await setupAdmin(t);
    const rid = await connect(t);
    {
      const r = await t.admin.call(`/api/repos/${rid}/runs`, 'POST', { task: 'Anything', runner: 'dry-run', skipBaseline: true, autonomy: 'auto', openPr: true });
      expect(r.status).toBe(201);
      const done = await wait(() => t.admin.call(`/api/repos/${rid}/runs/${r.json.id}`), (v) => v.json.state.phase === 'done' && !v.json.working && Boolean(v.json.state.pr), 'done with PR');
      expect(done.json.state.pr.url).toBe('https://github.com/acme/app/pull/12');
      expect(done.json.state.dev).toHaveLength(1);
    }
  });
});

describe('local mode', () => {
  async function local() {
    const repo = makeRepo();
    running = await startServer({ repos: new LocalRepo(repo, 'sample'), executor: inProcessExecutor({ runnerFor: () => new DryRunRunner() }), port: 0, env: {} });
    const base = running.url.replace(/\/$/, '');
    const c = client(base);
    await c.call('/api/me');
    return { base, c, repo };
  }

  it('is single-user with no login, and writes still need the token', async () => {
    const { base, c } = await local();
    const me = (await c.call('/api/me')).json;
    expect(me).toMatchObject({ mode: 'local', setupNeeded: false });
    expect(me.user.role).toBe('admin');
    expect((await c.call('/api/repos', 'POST', { url: 'https://github.com/a/b', token: 'x' })).status).toBe(403);
    expect((await c.call('/api/repos/local/runs', 'POST', { task: 'x' }, { 'x-agentpool-csrf': 'nope' })).status).toBe(403);
    const bad = await new Promise<number>((ok) => {
      const r = request({ host: '127.0.0.1', port: new URL(base).port, path: '/api/me', headers: { host: 'evil.example' } }, (res) => ok(res.statusCode ?? 0));
      r.end();
    });
    expect(bad).toBe(403);
  });

  it('drives a run to done in the working copy', async () => {
    const { c } = await local();
    const r = await c.call('/api/repos/local/runs', 'POST', { task: 'Anything', runner: 'dry-run', skipBaseline: true, autonomy: 'auto' });
    expect(r.status).toBe(201);
    const done = await wait(() => c.call(`/api/repos/local/runs/${r.json.id}`), (v) => v.json.state.phase === 'done' && !v.json.working, 'done');
    expect(done.json.mr).toContain('Status:');
    expect(done.json.next.join('\n')).toContain('agentpool pr');
  });
});
