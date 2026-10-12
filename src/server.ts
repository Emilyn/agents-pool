import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { NullChannel } from './channel.js';
import { PACKAGE_ROOT, loadAgents, loadRepoConfig } from './config.js';
import type { FetchLike } from './host.js';
import { fetchIssue, parseJiraRef, resolveJiraAuth, taskFromIssue } from './jira.js';
import { readiness } from './mr.js';
import { Orchestrator } from './orchestrator.js';
import { Accounts, AuthError, type PublicUser } from './platform/accounts.js';
import { InProcessExecutor, JobQueue, type Executor, type JobOutcome } from './platform/executor.js';
import { RepoError, type RepoProvider, type RepoRegistry } from './platform/repos.js';
import { commentOnJira, openPullRequest } from './publish.js';
import { nextSteps } from './report.js';
import { createRunner, type AgentRunner } from './runner.js';
import { RunStore } from './store.js';
import type { RunOptions, RunSource } from './types.js';

export interface AppOptions {
  repos: RepoProvider;
  /** Present in team mode. Without it the server is single-user and local. */
  accounts?: Accounts;
  /** Present in team mode: connect, retry and remove repositories. */
  registry?: RepoRegistry;
  executor: Executor;
  port?: number;
  host?: string;
  publicUrl?: string;
  allowedHosts?: string[];
  concurrency?: number;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  localUserName?: string;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

export interface RunningServer {
  server: Server;
  url: string;
  /** Local mode only: the write token the page reads from /api/me. */
  token: string;
  queue: JobQueue;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const MAX_BODY = 1_000_000;
const COOKIE = 'ap_session';

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

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json', extra: Record<string, string | string[]> = {}): void {
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'",
    ...extra,
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function cookieOf(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/**
 * The web app and its API. Team mode (accounts present): password login, server-side sessions, CSRF header and
 * Origin checks. Local mode (no accounts): one implicit admin, bound to loopback with Host checking and a per-process
 * write token. Either way, runs are repo-scoped, and agents only ever run through the executor.
 */
export async function startServer(opts: AppOptions): Promise<RunningServer> {
  const { repos, accounts, registry } = opts;
  const env = opts.env ?? process.env;
  const team = Boolean(accounts);
  const localToken = randomBytes(24).toString('hex');
  const bindHost = opts.host ?? '127.0.0.1';
  const secureCookie = Boolean(opts.publicUrl?.startsWith('https://'));
  const queue = new JobQueue(opts.executor, { concurrency: opts.concurrency, timeoutMs: opts.timeoutMs });
  const notices = new Map<string, string>();
  const stores = new Map<string, RunStore>();
  const storeFor = (rid: string): RunStore => {
    if (!repos.view(rid)) throw new HttpError(404, `No repository ${rid}`);
    let s = stores.get(rid);
    if (!s) stores.set(rid, (s = new RunStore(repos.pathFor(rid))));
    return s;
  };
  const jobKey = (rid: string, id: string) => `${rid}:${id}`;
  const page = readFileSync(join(PACKAGE_ROOT, 'web', 'index.html'), 'utf8');

  const orchestrator = (rid: string, user: PublicUser, runner: AgentRunner = createRunner('dry-run')) =>
    new Orchestrator({
      repoRoot: repos.pathFor(rid),
      store: storeFor(rid),
      runner,
      agents: loadAgents(repos.pathFor(rid)),
      channel: new NullChannel(),
      repoConfig: loadRepoConfig(repos.pathFor(rid)),
      humanId: user.name,
    });

  const publishDeps = (rid: string) => ({
    repoRoot: repos.pathFor(rid),
    store: storeFor(rid),
    config: loadRepoConfig(repos.pathFor(rid)),
    fetchImpl: opts.fetchImpl,
    env,
    ...repos.publishDeps(rid),
  });

  /** After a worker exits: record what went wrong, then open the pull request if the run asked for it. */
  async function afterJob(rid: string, id: string, outcome: JobOutcome, userName: string): Promise<void> {
    const store = storeFor(rid);
    const s0 = store.state(id);
    if (outcome.killed || (outcome.exitCode !== 0 && !s0.lastError)) {
      const why = outcome.killed === 'cancelled' ? `Stopped by ${userName}. Resume to continue.` : outcome.killed === 'timeout' ? 'The task hit the time limit. Resume to continue.' : `The worker exited with code ${outcome.exitCode}. ${outcome.output.trim().split('\n').slice(-4).join(' | ').slice(0, 500)}`;
      store.append(id, { type: 'system', id: 'server' }, { type: 'run.error', message: why });
      return;
    }
    const s = store.state(id);
    if (s.phase !== 'done') return;
    const deps = publishDeps(rid);
    if (s.options.openPr && !s.pr) {
      try {
        await openPullRequest(deps, id, { draft: s.options.draft });
      } catch (e) {
        notices.set(jobKey(rid, id), `The run is done, but opening the request failed: ${(e as Error).message}`);
        return;
      }
    }
    const f = store.state(id);
    if (f.options.jiraComment && f.pr && f.source && !f.jiraCommented) {
      try {
        await commentOnJira(deps, id);
      } catch (e) {
        notices.set(jobKey(rid, id), `Could not comment on ${f.source.key}: ${(e as Error).message}`);
      }
    }
  }

  function startJob(rid: string, id: string, user: PublicUser): boolean {
    notices.delete(jobKey(rid, id));
    return queue.enqueue({ runId: id, repoId: rid, repoPath: repos.pathFor(rid) }, (o) => afterJob(rid, id, o, user.name).catch((e) => void notices.set(jobKey(rid, id), (e as Error).message)));
  }

  const summary = (rid: string, id: string) => {
    const s = storeFor(rid).state(id);
    return { id, phase: s.phase, task: s.task.slice(0, 200), costUsd: s.costUsd, updatedAt: s.updatedAt, createdAt: s.createdAt, job: queue.state(id) ?? null, pr: s.pr?.url ?? null, ticket: s.source?.key ?? null, createdBy: s.createdBy ?? null };
  };

  const runView = (rid: string, id: string, after = 0) => {
    const store = storeFor(rid);
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
      job: queue.state(id) ?? null,
      working: Boolean(queue.state(id)),
      notice: notices.get(jobKey(rid, id)) ?? null,
      mr: mrFile && existsSync(mrFile) ? readFileSync(mrFile, 'utf8') : null,
    };
  };

  async function createRun(rid: string, user: PublicUser, body: any): Promise<string> {
    const path = repos.pathFor(rid);
    const cfg = loadRepoConfig(path);
    const runner = body.runner === 'dry-run' ? 'dry-run' : 'claude';
    let task = String(body.task ?? '').trim();
    let source: RunSource | undefined;
    if (body.jira) {
      const ref = parseJiraRef(String(body.jira));
      const auth = resolveJiraAuth({ urlBase: ref.baseUrl, configBase: cfg.jira.baseUrl }, env);
      ({ task, source } = taskFromIssue(await fetchIssue(ref.key, auth, opts.fetchImpl), task));
    }
    if (!task) throw new HttpError(400, 'Give a task, or a Jira issue.');
    if (task.length > 50_000) throw new HttpError(400, 'The task is too long (limit 50,000 characters).');
    const wanted = Number(body.budgetUsd) > 0 ? Number(body.budgetUsd) : (cfg.budgetUsd ?? 10);
    const options: RunOptions = {
      autonomy: body.autonomy === 'auto' ? 'auto' : (cfg.autonomy ?? 'plan-approval'),
      maxRounds: cfg.maxRounds ?? 2,
      budgetUsd: opts.maxBudgetUsd ? Math.min(wanted, opts.maxBudgetUsd) : wanted,
      agentBudgetUsd: cfg.agentBudgetUsd ?? 3,
      assumeDefaults: Boolean(body.assumeDefaults),
      runner,
      model: cfg.model,
      skipBaseline: Boolean(body.skipBaseline),
      ...(body.openPr ? { openPr: true } : {}),
      ...(body.jiraComment && source ? { jiraComment: true } : {}),
    };
    const base = await repos.prepare(rid, body.base ? String(body.base) : undefined);
    const id = await orchestrator(rid, user).startRun({ task, options, base: base.base, baseBranch: base.baseBranch, source });
    startJob(rid, id, user);
    return id;
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://local');
    const method = req.method ?? 'GET';
    const port = (server.address() as { port: number }).port;

    // Host check. Local mode must refuse DNS-rebinding; team mode relies on the session cookie and an optional allowlist.
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...(opts.allowedHosts ?? [])];
    if (opts.publicUrl) hosts.push(new URL(opts.publicUrl).host);
    if (bindHost !== '127.0.0.1' && bindHost !== '0.0.0.0') hosts.push(`${bindHost}:${port}`);
    const hostOk = hosts.includes(req.headers.host ?? '');
    if (!team && !hostOk) throw new HttpError(403, 'Unexpected Host header');
    if (team && (opts.allowedHosts?.length || opts.publicUrl) && !hostOk) throw new HttpError(403, 'Unexpected Host header');

    if (method === 'GET' && url.pathname === '/') return send(res, 200, page, 'text/html');
    if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
    const parts = url.pathname.split('/').filter(Boolean).slice(1);
    const [a, b, c, d, e] = parts;

    // Who is calling?
    const sessionToken = cookieOf(req, COOKIE);
    const sess = team ? accounts!.session(sessionToken) : { user: { id: 'local', name: opts.localUserName ?? env.USER ?? 'local', role: 'admin' as const, disabled: false, createdAt: '' }, csrf: localToken };
    const user = sess?.user;

    if (method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request refused');
    }

    // Public endpoints (team mode): status, first-run setup, login.
    if (a === 'me' && method === 'GET') {
      return send(res, 200, {
        user: user ?? null,
        csrf: sess?.csrf ?? null,
        setupNeeded: team ? !accounts!.hasUsers() : false,
        mode: team ? 'team' : 'local',
        executor: opts.executor.name,
        claudeKey: Boolean(env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN),
        jira: Boolean(env.JIRA_API_TOKEN && env.JIRA_EMAIL),
        maxBudgetUsd: opts.maxBudgetUsd ?? null,
      });
    }
    const startSession = async (name: string, password: string, create?: 'admin') => {
      if (create) await accounts!.create(name, password, create);
      const r = await accounts!.login(name, password);
      const cookie = `${COOKIE}=${encodeURIComponent(r.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Accounts.sessionSeconds}${secureCookie ? '; Secure' : ''}`;
      return send(res, 200, { user: r.user, csrf: r.csrf }, 'application/json', { 'Set-Cookie': cookie });
    };
    if (team && a === 'setup' && method === 'POST') {
      if (accounts!.hasUsers()) throw new HttpError(409, 'Setup is already done.');
      const body = await readJson(req);
      return startSession(String(body.name ?? ''), String(body.password ?? ''), 'admin');
    }
    if (team && a === 'login' && method === 'POST') {
      const body = await readJson(req);
      return startSession(String(body.name ?? ''), String(body.password ?? ''));
    }
    if (!user) throw new HttpError(401, 'Log in first.');

    if (method !== 'GET') {
      const sent = String(req.headers['x-agentpool-csrf'] ?? '');
      if (!sess || !safeEqual(sent, sess.csrf)) throw new HttpError(403, 'Missing or wrong CSRF token. Reload the page.');
    }
    const admin = user.role === 'admin';

    if (a === 'logout' && method === 'POST') {
      accounts?.logout(sessionToken);
      return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }

    if (a === 'users') {
      if (!team) throw new HttpError(404, 'Not found');
      if (!admin) throw new HttpError(403, 'Admins only.');
      if (method === 'GET' && !b) return send(res, 200, { users: accounts!.list() });
      if (method === 'POST' && !b) {
        const body = await readJson(req);
        return send(res, 201, await accounts!.create(String(body.name ?? ''), String(body.password ?? ''), body.role === 'admin' ? 'admin' : 'member'));
      }
      if (method === 'POST' && b && c === 'password') {
        await accounts!.setPassword(b, String((await readJson(req)).password ?? ''));
        return send(res, 200, { ok: true });
      }
      if (method === 'POST' && b && (c === 'disable' || c === 'enable')) {
        if (b === user.id && c === 'disable') throw new HttpError(400, 'You cannot disable yourself.');
        accounts!.setDisabled(b, c === 'disable');
        return send(res, 200, { ok: true });
      }
    }

    if (a === 'repos' && method === 'GET' && !b) return send(res, 200, { repos: repos.list() });
    if (a === 'repos' && method === 'POST' && !b) {
      if (!registry) throw new HttpError(403, 'Connecting repositories is a team-server feature. This server works on one local checkout.');
      const body = await readJson(req);
      return send(res, 201, await registry.add({ url: String(body.url ?? ''), token: String(body.token ?? ''), userId: user.name, host: body.host === 'gitlab' || body.host === 'github' ? body.host : undefined, apiUrl: body.apiUrl ? String(body.apiUrl) : undefined }));
    }
    if (a === 'repos' && b) {
      const rid = b;
      const view = repos.view(rid);
      if (!view) throw new HttpError(404, `No repository ${rid}`);
      if (!c && method === 'GET') return send(res, 200, view);
      if (!c && method === 'DELETE') {
        if (!registry) throw new HttpError(403, 'Not available in local mode.');
        if (!admin) throw new HttpError(403, 'Admins only.');
        if (queue.activeFor(rid) > 0) throw new HttpError(409, 'Tasks are running in this repository. Stop them first.');
        registry.remove(rid);
        stores.delete(rid);
        return send(res, 200, { ok: true });
      }
      if (c === 'sync' && method === 'POST') {
        if (!registry) throw new HttpError(403, 'Not available in local mode.');
        if (view.status === 'error') registry.retry(rid);
        else await repos.prepare(rid);
        return send(res, 200, repos.view(rid));
      }
      if (c === 'runs') {
        const store = storeFor(rid);
        if (!d && method === 'GET') return send(res, 200, { runs: store.list().reverse().map((id) => summary(rid, id)) });
        if (!d && method === 'POST') {
          if (view.status !== 'ready') throw new HttpError(409, view.status === 'cloning' ? 'The repository is still being cloned.' : `The repository is not usable: ${view.error ?? 'clone failed'}`);
          return send(res, 201, { id: await createRun(rid, user, await readJson(req)) });
        }
        const id = d!;
        if (!e && method === 'GET') return send(res, 200, runView(rid, id, Number(url.searchParams.get('after') ?? 0) || 0));
        if (e && method === 'POST') {
          if (!store.exists(id)) throw new HttpError(404, `No run ${id}`);
          const body = await readJson(req);
          const s = store.state(id);
          const orch = () => orchestrator(rid, user);
          const busy = () => {
            if (queue.state(id)) throw new HttpError(409, 'The task is working right now.');
          };
          switch (e) {
            case 'answer': {
              busy();
              const answer = String(body.answer ?? '').trim();
              if (!answer) throw new HttpError(400, 'Answer is empty');
              orch().answerQuestion(id, String(body.questionId ?? ''), answer);
              const left = store.state(id).questions.filter((q) => q.blocking && q.answer === undefined);
              if (left.length === 0) startJob(rid, id, user);
              return send(res, 200, { ok: true, resumed: left.length === 0 });
            }
            case 'approve':
            case 'reject': {
              busy();
              const gate = orch().decideGate(id, e === 'approve', body.note ? String(body.note) : undefined);
              startJob(rid, id, user);
              return send(res, 200, { ok: true, gate });
            }
            case 'resume':
              busy();
              startJob(rid, id, user);
              return send(res, 200, { ok: true });
            case 'cancel':
              if (!queue.cancel(id)) throw new HttpError(409, 'Nothing is running for this task.');
              return send(res, 200, { ok: true });
            case 'pr': {
              const deps = publishDeps(rid);
              const r = await openPullRequest(deps, id, { draft: typeof body.draft === 'boolean' ? body.draft : undefined });
              if (body.jiraComment && s.source) await commentOnJira(deps, id);
              return send(res, 200, r);
            }
          }
        }
      }
    }
    throw new HttpError(404, 'Not found');
  };

  const server = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError || err instanceof AuthError || err instanceof RepoError ? err.status : 400;
      if (!res.headersSent) send(res, status, { error: (err as Error).message });
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
    token: localToken,
    queue,
    url: opts.publicUrl ?? `http://127.0.0.1:${port}/`,
    async close() {
      queue.cancelAll();
      server.closeAllConnections?.();
      await new Promise<void>((ok) => server.close(() => ok()));
      await queue.idle();
      await registry?.idle();
    },
  };
}

/** The in-process executor behind `agentpool serve`: drives runs in this process with the real or a test runner. */
export function inProcessExecutor(opts: { runnerFor?: (kind: 'claude' | 'dry-run') => AgentRunner }): Executor {
  return new InProcessExecutor(async (job) => {
    const store = new RunStore(job.repoPath);
    const kind = store.state(job.runId).options.runner;
    await new Orchestrator({
      repoRoot: job.repoPath,
      store,
      runner: opts.runnerFor ? opts.runnerFor(kind) : createRunner(kind),
      agents: loadAgents(job.repoPath),
      channel: new NullChannel(),
      repoConfig: loadRepoConfig(job.repoPath),
    }).drive(job.runId);
  });
}

