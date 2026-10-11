import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RepoConfigSchema } from '../src/config.js';
import { createClient, detectHost, parseRemoteUrl, type FetchLike, type HostClient } from '../src/host.js';
import { adfToText, addComment, fetchIssue, parseJiraRef, resolveJiraAuth, taskFromIssue } from '../src/jira.js';
import { commentOnJira, openPullRequest, prBody } from '../src/publish.js';
import { DEV, PLAN, QA_PASS, REVIEW_OK, ScriptedRunner, defaultOptions, fenced, makeOrchestrator, makeRepo } from './helpers.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function mockFetch(routes: (url: string, init: RequestInit) => Response | undefined) {
  const calls: { url: string; method: string; body: any; headers: Record<string, string> }[] = [];
  const fn: FetchLike = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined, headers: (init.headers ?? {}) as Record<string, string> });
    return routes(url, init) ?? json(500, { message: `unexpected ${url}` });
  };
  return { fn, calls };
}

describe('remote URLs and host detection', () => {
  it('parses scp-like, https and ssh URLs', () => {
    expect(parseRemoteUrl('git@github.com:Emilyn/agents-pool.git')).toEqual({ hostname: 'github.com', path: 'Emilyn/agents-pool' });
    expect(parseRemoteUrl('https://github.com/Emilyn/agents-pool')).toEqual({ hostname: 'github.com', path: 'Emilyn/agents-pool' });
    expect(parseRemoteUrl('https://user:pw@gitlab.com/g/sub/proj.git/')).toEqual({ hostname: 'gitlab.com', path: 'g/sub/proj' });
    expect(parseRemoteUrl('ssh://git@git.acme.io:2222/team/app.git')).toEqual({ hostname: 'git.acme.io', path: 'team/app' });
  });
  it('rejects local paths and Windows drive letters', () => {
    expect(parseRemoteUrl('/tmp/some/bare.git')).toBeNull();
    expect(parseRemoteUrl('C:\\repos\\x')).toBeNull();
  });
  it('detects the host, with defaults and overrides', () => {
    expect(detectHost('git@github.com:a/b.git')).toMatchObject({ kind: 'github', apiUrl: 'https://api.github.com', project: 'a/b' });
    expect(detectHost('https://gitlab.com/g/s/p.git')).toMatchObject({ kind: 'gitlab', apiUrl: 'https://gitlab.com/api/v4', project: 'g/s/p' });
    expect(detectHost('https://git.acme.io/team/app.git', { host: 'gitlab' }).apiUrl).toBe('https://git.acme.io/api/v4');
    expect(detectHost('https://ghe.acme.io/o/r.git', { host: 'github' }).apiUrl).toBe('https://ghe.acme.io/api/v3');
    expect(detectHost('https://git.acme.io/t/a.git', { host: 'gitlab', apiUrl: 'https://x.io/gl/api/v4/' }).apiUrl).toBe('https://x.io/gl/api/v4');
  });
  it('asks for a hint when it cannot tell', () => {
    expect(() => detectHost('https://git.acme.io/team/app.git')).toThrow(/GitHub or GitLab/);
  });
});

describe('host clients', () => {
  const req = { title: 'T', body: 'B', head: 'agentpool/r1', base: 'main', draft: true };

  it('opens a GitHub draft pull request', async () => {
    const { fn, calls } = mockFetch((url) => (url.endsWith('/repos/a/b/pulls') ? json(201, { html_url: 'https://github.com/a/b/pull/7', number: 7 }) : undefined));
    const r = await createClient(detectHost('git@github.com:a/b.git'), 'tok', fn).createOrFind(req);
    expect(r).toEqual({ url: 'https://github.com/a/b/pull/7', number: 7, existing: false });
    expect(calls[0]?.body).toMatchObject({ head: 'agentpool/r1', base: 'main', draft: true, title: 'T' });
    expect(calls[0]?.headers.Authorization).toBe('Bearer tok');
  });
  it('returns the existing GitHub PR when creation says 422', async () => {
    const { fn } = mockFetch((url, init) =>
      init.method === 'POST' ? json(422, { message: 'Validation Failed', errors: [{ message: 'A pull request already exists' }] }) : url.includes('/pulls?') ? json(200, [{ html_url: 'u', number: 3 }]) : undefined,
    );
    expect(await createClient(detectHost('git@github.com:a/b.git'), 't', fn).createOrFind(req)).toEqual({ url: 'u', number: 3, existing: true });
  });
  it('gives actionable errors', async () => {
    const gh = detectHost('git@github.com:a/b.git');
    await expect(createClient(gh, 't', mockFetch(() => json(401, { message: 'Bad credentials' })).fn).createOrFind(req)).rejects.toThrow(/rejected the token/);
    await expect(createClient(gh, 't', mockFetch(() => json(404, {})).fn).createOrFind(req)).rejects.toThrow(/not found/);
    await expect(createClient(gh, 't', mockFetch(() => json(422, { errors: [{ message: 'Draft pull requests are not supported in this repository' }] })).fn).createOrFind(req)).rejects.toThrow(/--no-draft/);
  });
  it('opens a GitLab merge request with the Draft prefix and encoded project path', async () => {
    const { fn, calls } = mockFetch(() => json(201, { web_url: 'https://gitlab.com/g/s/p/-/merge_requests/4', iid: 4 }));
    const r = await createClient(detectHost('https://gitlab.com/g/s/p.git'), 'tok', fn).createOrFind(req);
    expect(r).toEqual({ url: 'https://gitlab.com/g/s/p/-/merge_requests/4', number: 4, existing: false });
    expect(calls[0]?.url).toBe('https://gitlab.com/api/v4/projects/g%2Fs%2Fp/merge_requests');
    expect(calls[0]?.body).toMatchObject({ source_branch: 'agentpool/r1', target_branch: 'main', title: 'Draft: T', description: 'B' });
    expect(calls[0]?.headers['PRIVATE-TOKEN']).toBe('tok');
  });
  it('does not prefix a ready GitLab MR, and finds an existing one on 409', async () => {
    const { fn, calls } = mockFetch((url, init) => (init.method === 'POST' ? json(409, { message: ['Another open merge request already exists'] }) : json(200, [{ web_url: 'w', iid: 9 }])));
    const r = await createClient(detectHost('https://gitlab.com/g/p.git'), 't', fn).createOrFind({ ...req, draft: false });
    expect(r).toEqual({ url: 'w', number: 9, existing: true });
    expect(calls[0]?.body.title).toBe('T');
  });
});

describe('Jira Cloud', () => {
  const auth = { baseUrl: 'https://acme.atlassian.net', email: 'me@acme.com', token: 'tok' };
  const adf = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Users need CSV export.' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'UTF-8' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Header row' }] }] }] },
      { type: 'codeBlock', content: [{ type: 'text', text: 'a,b' }] },
    ],
  };

  it('parses keys and URLs', () => {
    expect(parseJiraRef('proj-12')).toEqual({ key: 'PROJ-12' });
    expect(parseJiraRef('https://acme.atlassian.net/browse/PROJ-12?x=1')).toEqual({ key: 'PROJ-12', baseUrl: 'https://acme.atlassian.net' });
    expect(parseJiraRef('https://acme.atlassian.net/jira/software/projects/P/boards/1?selectedIssue=PR-5')).toEqual({ key: 'PR-5', baseUrl: 'https://acme.atlassian.net' });
    expect(() => parseJiraRef('nonsense')).toThrow();
  });
  it('flattens ADF to text', () => {
    const text = adfToText(adf);
    expect(text).toContain('Users need CSV export.');
    expect(text).toContain('- UTF-8');
    expect(text).toContain('- Header row');
    expect(text).toContain('```\na,b\n```');
  });
  it('explains missing configuration without printing secrets', () => {
    expect(() => resolveJiraAuth({}, {})).toThrow(/JIRA_EMAIL.*JIRA_API_TOKEN|JIRA_BASE_URL/s);
    expect(resolveJiraAuth({ urlBase: 'https://a.atlassian.net/' }, { JIRA_EMAIL: 'e', JIRA_API_TOKEN: 't', JIRA_BASE_URL: 'https://other' }).baseUrl).toBe('https://a.atlassian.net');
  });
  it('fetches an issue and builds the task', async () => {
    const { fn, calls } = mockFetch(() => json(200, { key: 'PROJ-1', fields: { summary: 'CSV export', description: adf, issuetype: { name: 'Story' }, status: { name: 'To Do' }, priority: { name: 'High' }, labels: ['reports'] } }));
    const issue = await fetchIssue('PROJ-1', auth, fn);
    expect(calls[0]?.url).toContain('/rest/api/3/issue/PROJ-1');
    expect(calls[0]?.headers.Authorization).toBe(`Basic ${Buffer.from('me@acme.com:tok').toString('base64')}`);
    const { task, source } = taskFromIssue(issue, 'use the existing csv helper');
    expect(task).toMatch(/^PROJ-1: CSV export/);
    expect(task).toContain('Users need CSV export.');
    expect(task).toContain('Additional instructions from the developer:\nuse the existing csv helper');
    expect(source).toEqual({ type: 'jira', key: 'PROJ-1', url: 'https://acme.atlassian.net/browse/PROJ-1', summary: 'CSV export' });
  });
  it('reports a missing issue clearly', async () => {
    await expect(fetchIssue('PROJ-9', auth, mockFetch(() => json(404, {})).fn)).rejects.toThrow(/could not find PROJ-9/);
  });
  it('posts a comment as ADF with a link', async () => {
    const { fn, calls } = mockFetch(() => json(201, {}));
    await addComment('PROJ-1', 'Opened:', { label: 'link', url: 'https://x/pr/1' }, auth, fn);
    expect(calls[0]?.url).toBe('https://acme.atlassian.net/rest/api/3/issue/PROJ-1/comment');
    expect(JSON.stringify(calls[0]?.body)).toContain('"href":"https://x/pr/1"');
  });
});

describe('opening a pull request from a finished run', () => {
  const happy = () => ({
    planner: () => fenced(PLAN),
    developer: (req: { cwd: string }) => {
      writeFileSync(join(req.cwd, 'greeting.txt'), 'hello\n');
      return fenced(DEV);
    },
    qa: () => fenced(QA_PASS),
    reviewer: () => fenced(REVIEW_OK),
  });

  async function setup(source?: { type: 'jira'; key: string; url: string; summary: string }) {
    const repo = makeRepo();
    const bare = mkdtempSync(join(tmpdir(), 'agentpool-bare-'));
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: repo });
    const { orchestrator, store } = makeOrchestrator(repo, new ScriptedRunner(happy()));
    const id = await orchestrator.startRun({ task: 'Add a greeting file', options: defaultOptions(), source });
    await orchestrator.drive(id);
    const created: any[] = [];
    const client: HostClient = {
      ref: detectHost('git@github.com:a/b.git'),
      async createOrFind(r) {
        created.push(r);
        return { url: 'https://github.com/a/b/pull/1', number: 1, existing: false };
      },
    };
    const deps = { repoRoot: repo, store, config: RepoConfigSchema.parse({}), client };
    return { repo, bare, id, store, deps, created };
  }

  it('pushes the branch to the remote, opens the PR, and records it once', async () => {
    const { bare, id, store, deps, created } = await setup();
    const r = await openPullRequest(deps, id);
    expect(r).toMatchObject({ url: 'https://github.com/a/b/pull/1', existing: false, draft: false });
    expect(execFileSync('git', ['branch', '--list', `agentpool/${id}`], { cwd: bare }).toString()).toContain(id);
    expect(created[0]).toMatchObject({ head: `agentpool/${id}`, base: 'main', draft: false, title: 'Add a greeting file' });
    expect(created[0].body).toContain('Status: ready for human review');
    expect(created[0].body).not.toContain('Open it as a merge request');
    expect(store.state(id).pr?.number).toBe(1);

    const again = await openPullRequest(deps, id);
    expect(again.existing).toBe(true);
    expect(created).toHaveLength(1);
  });

  it('dry run pushes nothing', async () => {
    const { bare, id, deps, created } = await setup();
    const r = await openPullRequest(deps, id, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(created).toHaveLength(0);
    expect(execFileSync('git', ['branch', '--list'], { cwd: bare }).toString()).not.toContain(id);
  });

  it('refuses before pushing when the base branch is not on the remote', async () => {
    const { repo, id, deps } = await setup();
    const empty = mkdtempSync(join(tmpdir(), 'agentpool-empty-'));
    execFileSync('git', ['init', '--bare', '-q', empty]);
    execFileSync('git', ['remote', 'set-url', 'origin', empty], { cwd: repo });
    await expect(openPullRequest(deps, id)).rejects.toThrow(/does not exist on origin/);
  });

  it('refuses to open a run that is not finished', async () => {
    const { deps, store } = await setup();
    const repo = deps.repoRoot;
    const { orchestrator } = makeOrchestrator(repo, new ScriptedRunner(happy()));
    const id2 = await orchestrator.startRun({ task: 'x', options: defaultOptions() });
    await expect(openPullRequest({ ...deps, store }, id2)).rejects.toThrow(/Only a finished run/);
  });

  it('stops with a clear message when no token is available', async () => {
    const { deps, id, repo } = await setup();
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://gitlab.com/g/p.git'], { cwd: repo });
    const { client: _c, ...noClient } = deps;
    await expect(openPullRequest({ ...noClient, env: {} }, id, { host: 'gitlab' })).rejects.toThrow(/No GitLab token found/);
  });

  it('uses the ticket in the title and can comment back on Jira once', async () => {
    const src = { type: 'jira' as const, key: 'PROJ-7', url: 'https://acme.atlassian.net/browse/PROJ-7', summary: 'Greeting' };
    const { deps, id, created } = await setup(src);
    await openPullRequest(deps, id);
    expect(created[0].title).toBe('PROJ-7: Greeting');
    const { fn, calls } = mockFetch(() => json(201, {}));
    const jiraDeps = { ...deps, fetchImpl: fn, env: { JIRA_EMAIL: 'e@x.com', JIRA_API_TOKEN: 't' } };
    expect(await commentOnJira(jiraDeps, id)).toBe(true);
    expect(calls[0]?.url).toBe('https://acme.atlassian.net/rest/api/3/issue/PROJ-7/comment');
    expect(await commentOnJira(jiraDeps, id)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('strips the shell instructions and caps very long bodies', () => {
    expect(prBody('# T\n\nbody\n\n## Open it as a merge request\n```sh\ngit push\n```\n')).toBe('# T\n\nbody');
    expect(prBody('x'.repeat(70_000)).length).toBeLessThan(60_100);
  });
});
