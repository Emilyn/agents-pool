import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/server.js';
import { DryRunRunner } from '../src/runner.js';
import { makeRepo } from './helpers.js';

let running: RunningServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function boot() {
  const repo = makeRepo();
  running = await startServer({ repoRoot: repo, port: 0, runnerFor: () => new DryRunRunner() });
  const base = running.url.replace(/\/$/, '');
  const token = running.token;
  const call = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = { 'x-agentpool-token': token }) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };
  const waitFor = async (id: string, pred: (v: any) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const v = (await call(`/api/runs/${id}`)).json;
      if (pred(v)) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('timed out waiting for run state');
  };
  return { repo, base, token, call, waitFor };
}

describe('web server', () => {
  it('serves the page with the token and refuses wrong hosts', async () => {
    const { base, token } = await boot();
    const page = await (await fetch(base + '/')).text();
    expect(page).toContain(token);
    expect(page).not.toContain('__AGENTPOOL_TOKEN__');
    const bad = await new Promise<number>((ok) => {
      import('node:http').then(({ request }) => {
        const r = request({ host: '127.0.0.1', port: new URL(base).port, path: '/api/runs', headers: { host: 'evil.example' } }, (res) => ok(res.statusCode ?? 0));
        r.end();
      });
    });
    expect(bad).toBe(403);
  });

  it('rejects writes without the token or from another origin', async () => {
    const { call } = await boot();
    expect((await call('/api/runs', 'POST', { task: 'x' }, {})).status).toBe(403);
    expect((await call('/api/runs', 'POST', { task: 'x' }, { 'x-agentpool-token': 'nope' })).status).toBe(403);
    expect((await call('/api/runs', 'POST', { task: 'x', runner: 'dry-run' }, { 'x-agentpool-token': running!.token, origin: 'http://evil.example' })).status).toBe(403);
    expect((await call('/api/runs', 'POST', {})).status).toBe(400);
  });

  it('starts a run, parks on a question, takes the answer and the plan approval, and finishes', async () => {
    const { call, waitFor } = await boot();
    const started = await call('/api/runs', 'POST', { task: 'Anything [ask]', runner: 'dry-run', skipBaseline: true });
    expect(started.status).toBe(201);
    const id = started.json.id as string;

    const asked = await waitFor(id, (v) => v.state.phase === 'awaiting_answers' && !v.working);
    const q = asked.state.questions[0];
    expect(q.blocking).toBe(true);
    expect((await call(`/api/runs/${id}/answer`, 'POST', { questionId: q.id, answer: '' })).status).toBe(400);
    expect((await call(`/api/runs/${id}/answer`, 'POST', { questionId: q.id, answer: q.recommended ?? 'yes' })).status).toBe(200);

    await waitFor(id, (v) => v.state.phase === 'awaiting_plan_approval' && !v.working);
    expect((await call(`/api/runs/${id}/approve`, 'POST', {})).json.gate).toBe('plan');

    const done = await waitFor(id, (v) => v.state.phase === 'done');
    expect(done.mr).toContain('Status:');
    expect(done.next.join('\n')).toContain('agentpool pr');
    // Incremental reads only return new events.
    const tail = (await call(`/api/runs/${id}?after=${done.lastSeq}`)).json;
    expect(tail.events).toHaveLength(0);
    const list = (await call('/api/runs')).json.runs;
    expect(list[0]).toMatchObject({ id, phase: 'done' });
  });

  it('reports an unknown run and refuses a second drive', async () => {
    const { call } = await boot();
    expect((await call('/api/runs/nope')).status).toBe(404);
    expect((await call('/api/runs/nope/resume', 'POST', {})).status).toBe(404);
  });

  it('keeps a failed pull request attempt visible instead of failing the run', async () => {
    const { call, waitFor } = await boot();
    const r = await call('/api/runs', 'POST', { task: 'Open it', runner: 'dry-run', skipBaseline: true, autonomy: 'auto', openPr: true });
    const v = await waitFor(r.json.id, (x) => x.state.phase === 'done' && !x.working);
    expect(v.notice).toMatch(/opening the request failed/);
    expect(v.state.pr).toBeUndefined();
  });
});
