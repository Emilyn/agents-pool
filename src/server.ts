import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { NullChannel } from './channel.js';
import { PACKAGE_ROOT, loadAgents, loadRepoConfig } from './config.js';
import { isDirty } from './git.js';
import { createRunner, type AgentRunner } from './runner.js';
import { Orchestrator } from './orchestrator.js';
import { fetchIssue, parseJiraRef, resolveJiraAuth, taskFromIssue } from './jira.js';
import { commentOnJira, openPullRequest } from './publish.js';
import { nextSteps } from './report.js';
import { readiness } from './mr.js';
import { RunStore } from './store.js';
import type { RunOptions, RunSource } from './types.js';
import type { FetchLike } from './host.js';

export interface ServeOptions {
  repoRoot: string;
  port?: number;
  host?: string;
  /** Tests inject a runner instead of building one from the run's options. */
  runnerFor?: (kind: 'claude' | 'dry-run') => AgentRunner;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  token?: string;
}

export interface RunningServer {
  server: Server;
  url: string;
  token: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const MAX_BODY = 1_000_000;

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'",
  });
  res.end(data);
}

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * A local web UI over the same event logs the CLI uses. It listens on 127.0.0.1 only, rejects requests whose
 * Host header is not the local address (DNS rebinding), and requires a per-process token on every write.
 * Runs execute in this process; closing the server stops the agents, and `agentpool resume` continues them.
 */
export async function startServer(opts: ServeOptions): Promise<RunningServer> {
  const { repoRoot } = opts;
  const store = new RunStore(repoRoot);
  const token = opts.token ?? randomBytes(24).toString('hex');
  const active = new Map<string, Promise<void>>();
  const notices = new Map<string, string>();
  const bindHost = opts.host ?? '127.0.0.1';

  const orchestratorFor = (kind: 'claude' | 'dry-run') =>
    new Orchestrator({
      repoRoot,
      store,
      runner: opts.runnerFor ? opts.runnerFor(kind) : createRunner(kind),
      agents: loadAgents(repoRoot),
      channel: new NullChannel(),
      repoConfig: loadRepoConfig(repoRoot),
    });

  /** Drive a run in the background, then open the PR if the run asked for that. One drive per run at a time. */
  function startDrive(id: string): void {
    if (active.has(id)) return;
    notices.delete(id);
    const job = (async () => {
      try {
        const s0 = store.state(id);
        const s = await orchestratorFor(s0.options.runner).drive(id);
        if (s.phase !== 'done') return;
        const deps = { repoRoot, store, config: loadRepoConfig(repoRoot), fetchImpl: opts.fetchImpl, env: opts.env };
        if (s.options.openPr && !s.pr) {
          try {
            await openPullRequest(deps, id, { draft: s.options.draft });
          } catch (e) {
            notices.set(id, `The run is done, but opening the request failed: ${(e as Error).message}`);
            return;
          }
        }
        const f = store.state(id);
        if (f.options.jiraComment && f.pr && f.source && !f.jiraCommented) {
          try {
            await commentOnJira(deps, id);
          } catch (e) {
            notices.set(id, `Could not comment on ${f.source.key}: ${(e as Error).message}`);
          }
        }
      } catch (e) {
        notices.set(id, (e as Error).message);
      } finally {
        active.delete(id);
      }
    })();
    active.set(id, job);
  }

  const runView = (id: string, after = 0) => {
    if (!store.exists(id)) throw new HttpError(404, `No run ${id}`);
    const events = store.events(id);
    const s = store.state(id);
    const mrFile = s.outcome?.mrFile;
    return {
      state: s,
      events: events.filter((e) => e.seq > after),
      lastSeq: events.at(-1)?.seq ?? 0,
      readiness: readiness(s),
      next: nextSteps(s),
      working: active.has(id),
      notice: notices.get(id) ?? null,
      mr: mrFile && existsSync(mrFile) ? readFileSync(mrFile, 'utf8') : null,
    };
  };

  const summary = (id: string) => {
    const s = store.state(id);
    return { id, phase: s.phase, task: s.task.slice(0, 200), costUsd: s.costUsd, updatedAt: s.updatedAt, working: active.has(id), pr: s.pr?.url ?? null, ticket: s.source?.key ?? null };
  };

  async function startRun(body: any): Promise<string> {
    const cfg = loadRepoConfig(repoRoot);
    const runner = body.runner === 'dry-run' ? 'dry-run' : 'claude';
    let task = String(body.task ?? '').trim();
    let source: RunSource | undefined;
    if (body.jira) {
      const ref = parseJiraRef(String(body.jira));
      const auth = resolveJiraAuth({ urlBase: ref.baseUrl, configBase: cfg.jira.baseUrl }, opts.env);
      ({ task, source } = taskFromIssue(await fetchIssue(ref.key, auth, opts.fetchImpl), task));
    }
    if (!task) throw new HttpError(400, 'Give a task, or a Jira issue.');
    const autonomy = body.autonomy === 'auto' ? 'auto' : (cfg.autonomy ?? 'plan-approval');
    const options: RunOptions = {
      autonomy,
      maxRounds: cfg.maxRounds ?? 2,
      budgetUsd: Number(body.budgetUsd) > 0 ? Number(body.budgetUsd) : (cfg.budgetUsd ?? 10),
      agentBudgetUsd: cfg.agentBudgetUsd ?? 3,
      assumeDefaults: Boolean(body.assumeDefaults),
      runner,
      model: cfg.model,
      skipBaseline: Boolean(body.skipBaseline),
      ...(body.openPr ? { openPr: true } : {}),
      ...(body.jiraComment && source ? { jiraComment: true } : {}),
    };
    const id = await orchestratorFor(runner).startRun({ task, options, base: body.base ? String(body.base) : undefined, source });
    startDrive(id);
    return id;
  }

  const page = readFileSync(join(PACKAGE_ROOT, 'web', 'index.html'), 'utf8');

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://local');
    const method = req.method ?? 'GET';
    const port = (server.address() as { port: number }).port;
    const okHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    if (bindHost !== '127.0.0.1') okHosts.push(`${bindHost}:${port}`);
    if (!okHosts.includes(req.headers.host ?? '')) throw new HttpError(403, 'Unexpected Host header');

    if (method === 'GET' && url.pathname === '/') {
      return send(res, 200, page.replace('__AGENTPOOL_TOKEN__', token), 'text/html');
    }
    if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');

    if (method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && !okHosts.some((h) => origin === `http://${h}`)) throw new HttpError(403, 'Cross-origin request refused');
      const sent = String(req.headers['x-agentpool-token'] ?? '');
      if (!safeEqual(sent, token)) throw new HttpError(403, 'Missing or wrong token');
    }

    const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
    const [a, id, action] = parts;

    if (method === 'GET' && a === 'info') {
      const cfg = loadRepoConfig(repoRoot);
      return send(res, 200, {
        repo: repoRoot,
        dirty: await isDirty(repoRoot),
        claudeKey: Boolean((opts.env ?? process.env).ANTHROPIC_API_KEY || (opts.env ?? process.env).CLAUDE_CODE_OAUTH_TOKEN),
        jira: Boolean((opts.env ?? process.env).JIRA_API_TOKEN && (opts.env ?? process.env).JIRA_EMAIL),
        autonomy: cfg.autonomy ?? 'plan-approval',
      });
    }
    if (method === 'GET' && a === 'runs' && !id) {
      return send(res, 200, { runs: store.list().reverse().map(summary) });
    }
    if (method === 'GET' && a === 'runs' && id && !action) {
      return send(res, 200, runView(id, Number(url.searchParams.get('after') ?? 0) || 0));
    }
    if (method === 'POST' && a === 'runs' && !id) {
      const body = await readJson(req);
      return send(res, 201, { id: await startRun(body) });
    }
    if (method === 'POST' && a === 'runs' && id && action) {
      if (!store.exists(id)) throw new HttpError(404, `No run ${id}`);
      const body = await readJson(req);
      const s = store.state(id);
      const orch = () => orchestratorFor(s.options.runner);
      switch (action) {
        case 'answer': {
          if (active.has(id)) throw new HttpError(409, 'The run is working right now.');
          orch().answerQuestion(id, String(body.questionId ?? ''), String(body.answer ?? '').trim() || (() => { throw new HttpError(400, 'Answer is empty'); })());
          // Carry on once nothing blocking is left open.
          const left = store.state(id).questions.filter((q) => q.blocking && q.answer === undefined);
          if (left.length === 0) startDrive(id);
          return send(res, 200, { ok: true, resumed: left.length === 0 });
        }
        case 'approve':
        case 'reject': {
          if (active.has(id)) throw new HttpError(409, 'The run is working right now.');
          const gate = orch().decideGate(id, action === 'approve', body.note ? String(body.note) : undefined);
          startDrive(id);
          return send(res, 200, { ok: true, gate });
        }
        case 'resume':
          if (active.has(id)) throw new HttpError(409, 'The run is already working.');
          startDrive(id);
          return send(res, 200, { ok: true });
        case 'pr': {
          const deps = { repoRoot, store, config: loadRepoConfig(repoRoot), fetchImpl: opts.fetchImpl, env: opts.env };
          const r = await openPullRequest(deps, id, { draft: typeof body.draft === 'boolean' ? body.draft : undefined });
          if (body.jiraComment && s.source) await commentOnJira(deps, id);
          return send(res, 200, r);
        }
      }
    }
    throw new HttpError(404, 'Not found');
  };

  const server = createServer((req, res) => {
    handler(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 400;
      if (!res.headersSent) send(res, status, { error: (e as Error).message });
      else res.end();
    });
  });

  await new Promise<void>((ok, bad) => {
    server.once('error', bad);
    server.listen(opts.port ?? 4317, bindHost, ok);
  });
  const port = (server.address() as { port: number }).port;
  return {
    server,
    token,
    url: `http://127.0.0.1:${port}/`,
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((ok) => server.close(() => ok()));
      await Promise.allSettled([...active.values()]);
    },
  };
}
