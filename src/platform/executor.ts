import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../config.js';

export interface JobSpec {
  runId: string;
  repoId: string;
  /** The server-side clone holding the run's event log and worktree. */
  repoPath: string;
}

export interface JobOutcome {
  exitCode: number | null;
  /** The tail of what the worker printed, for the server log. */
  output: string;
  killed?: 'cancelled' | 'timeout';
}

/** Runs `agentpool work <run>` somewhere. The worker drives the run to its next stopping point and exits. */
export interface Executor {
  readonly name: string;
  run(job: JobSpec, signal: AbortSignal): Promise<JobOutcome>;
}

const tail = (s: string, n = 4000) => (s.length > n ? s.slice(-n) : s);

/** Environment variables a worker may see. Repository and Jira tokens are never among them. */
export const WORKER_ENV_ALLOW = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_REGION', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NPM_CONFIG_REGISTRY', 'PIP_INDEX_URL'];

export function workerEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.AGENTPOOL_WORKER_ENV ?? '').split(',').map((s) => s.trim()).filter((s) => /^[A-Z_][A-Z0-9_]*$/i.test(s));
  return [...new Set([...WORKER_ENV_ALLOW, ...extra])].filter((n) => env[n] !== undefined);
}

export interface DockerOptions {
  image: string;
  cpus?: string;
  memory?: string;
  pids?: number;
  network?: string;
  /** uid:gid the worker runs as, so files it writes stay owned by the server user. */
  user?: string;
  dockerBin?: string;
  env?: NodeJS.ProcessEnv;
}

/** The `docker run` arguments for one task. Exposed so the isolation settings can be tested without a daemon. */
export function dockerRunArgs(job: JobSpec, o: DockerOptions): string[] {
  const env = o.env ?? process.env;
  const user = o.user ?? (typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid?.() ?? process.getuid()}` : undefined);
  return [
    'run', '--rm', '--init',
    '--name', containerName(job.runId),
    '--label', 'agentpool=1',
    '--cpus', o.cpus ?? '2',
    '--memory', o.memory ?? '4g',
    '--pids-limit', String(o.pids ?? 512),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    ...(o.network ? ['--network', o.network] : []),
    ...(user ? ['--user', user] : []),
    '--tmpfs', '/tmp:rw,exec,mode=1777,size=2g',
    '-e', 'HOME=/tmp',
    ...workerEnvNames(env).flatMap((n) => ['-e', n]), // by name only: the value is read from the docker CLI's environment, never printed
    '-v', `${job.repoPath}:${job.repoPath}`,
    '-w', job.repoPath,
    o.image,
    'work', job.runId, '--repo', job.repoPath,
  ];
}

export const containerName = (runId: string): string => `agentpool-${runId.replace(/[^A-Za-z0-9_.-]/g, '-')}`;

function collect(child: ReturnType<typeof spawn>): () => string {
  let out = '';
  const add = (d: Buffer) => {
    out += d.toString();
    if (out.length > 100_000) out = out.slice(-50_000);
  };
  child.stdout?.on('data', add);
  child.stderr?.on('data', add);
  return () => tail(out);
}

/** One fresh container per task: only that repository's clone is mounted, with resource limits and no repo tokens. */
export class DockerExecutor implements Executor {
  readonly name = 'docker';
  constructor(private readonly o: DockerOptions) {}

  run(job: JobSpec, signal: AbortSignal): Promise<JobOutcome> {
    const bin = this.o.dockerBin ?? 'docker';
    const child = spawn(bin, dockerRunArgs(job, this.o), { env: this.o.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = collect(child);
    return new Promise((resolve) => {
      let killed: JobOutcome['killed'];
      const stop = () => {
        killed = 'cancelled';
        // Killing the CLI would leave the container running; ask the daemon to stop it.
        execFile(bin, ['kill', containerName(job.runId)], () => undefined);
      };
      if (signal.aborted) stop();
      signal.addEventListener('abort', stop, { once: true });
      child.on('error', (e) => resolve({ exitCode: null, output: `Could not start docker: ${e.message}` }));
      child.on('close', (code) => resolve({ exitCode: code, output: output(), killed }));
    });
  }
}

/** Runs the worker as a child process on the server. No container: only for a trusted single team or development. */
export class LocalExecutor implements Executor {
  readonly name = 'local';
  constructor(private readonly o: { cliPath?: string; env?: NodeJS.ProcessEnv } = {}) {}

  run(job: JobSpec, signal: AbortSignal): Promise<JobOutcome> {
    const src = this.o.env ?? process.env;
    const cli = this.o.cliPath ?? join(PACKAGE_ROOT, 'dist', 'cli.js');
    if (!existsSync(cli)) return Promise.resolve({ exitCode: null, output: `Worker entry point not found: ${cli}. Run \`npm run build\`.` });
    const env: NodeJS.ProcessEnv = { PATH: src.PATH, HOME: src.HOME, LANG: src.LANG, CI: '1' };
    for (const n of workerEnvNames(src)) env[n] = src[n];
    const child = spawn(process.execPath, [cli, 'work', job.runId, '--repo', job.repoPath], { cwd: job.repoPath, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = collect(child);
    return new Promise((resolve) => {
      let killed: JobOutcome['killed'];
      const stop = () => {
        killed = 'cancelled';
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      if (signal.aborted) stop();
      signal.addEventListener('abort', stop, { once: true });
      child.on('error', (e) => resolve({ exitCode: null, output: e.message }));
      child.on('close', (code) => resolve({ exitCode: code, output: output(), killed }));
    });
  }
}

/** Runs the job in this process. For tests and for the local `serve` mode. */
export class InProcessExecutor implements Executor {
  readonly name = 'in-process';
  constructor(private readonly fn: (job: JobSpec, signal: AbortSignal) => Promise<void>) {}
  async run(job: JobSpec, signal: AbortSignal): Promise<JobOutcome> {
    try {
      await this.fn(job, signal);
      return { exitCode: 0, output: '', killed: signal.aborted ? 'cancelled' : undefined };
    } catch (e) {
      return { exitCode: 1, output: (e as Error).message };
    }
  }
}

export type JobState = 'queued' | 'running';

/** Bounded concurrency, a time limit per job, and cancellation. At most one job per run at a time. */
export class JobQueue {
  private waiting: { job: JobSpec; done: (o: JobOutcome) => void | Promise<void> }[] = [];
  private running = new Map<string, AbortController>();

  constructor(
    private readonly executor: Executor,
    private readonly opts: { concurrency?: number; timeoutMs?: number } = {},
  ) {}

  state(runId: string): JobState | undefined {
    if (this.running.has(runId)) return 'running';
    return this.waiting.some((w) => w.job.runId === runId) ? 'queued' : undefined;
  }

  activeFor(repoId: string): number {
    return this.waiting.filter((w) => w.job.repoId === repoId).length + [...this.runningJobs.values()].filter((j) => j.repoId === repoId).length;
  }

  private runningJobs = new Map<string, JobSpec>();

  /** Returns false when the run already has a job. */
  enqueue(job: JobSpec, done: (o: JobOutcome) => void | Promise<void>): boolean {
    if (this.state(job.runId)) return false;
    this.waiting.push({ job, done });
    this.pump();
    return true;
  }

  cancel(runId: string): boolean {
    const i = this.waiting.findIndex((w) => w.job.runId === runId);
    if (i >= 0) {
      this.waiting.splice(i, 1);
      return true;
    }
    const c = this.running.get(runId);
    if (!c) return false;
    c.abort();
    return true;
  }

  private pump(): void {
    const limit = this.opts.concurrency ?? 2;
    while (this.running.size < limit && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      const ctl = new AbortController();
      this.running.set(next.job.runId, ctl);
      this.runningJobs.set(next.job.runId, next.job);
      let timedOut = false;
      const timer = this.opts.timeoutMs ? setTimeout(() => { timedOut = true; ctl.abort(); }, this.opts.timeoutMs) : undefined;
      void this.executor
        .run(next.job, ctl.signal)
        .catch((e): JobOutcome => ({ exitCode: null, output: (e as Error).message }))
        .then(async (outcome) => {
          if (timer) clearTimeout(timer);
          if (timedOut) outcome.killed = 'timeout';
          this.running.delete(next.job.runId);
          this.runningJobs.delete(next.job.runId);
          try {
            await next.done(outcome);
          } finally {
            this.pump();
          }
        });
    }
  }

  /** Wait for everything queued or running to finish (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running.size > 0 || this.waiting.length > 0) await new Promise((r) => setTimeout(r, 20));
  }

  cancelAll(): void {
    this.waiting = [];
    for (const c of this.running.values()) c.abort();
  }
}
