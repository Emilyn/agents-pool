#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Command } from 'commander';
import { NullChannel, TerminalChannel } from './channel.js';
import { PACKAGE_ROOT, loadAgents, loadRepoConfig } from './config.js';
import { isGitRepo, isDirty, hasCommits, git, repoRoot as gitRoot } from './git.js';
import { detectHost, resolveToken, type HostKind } from './host.js';
import { fetchIssue, parseJiraRef, resolveJiraAuth, taskFromIssue } from './jira.js';
import { Orchestrator } from './orchestrator.js';
import { detectProfile } from './profile.js';
import { commentOnJira, openPullRequest } from './publish.js';
import { loadMasterKey } from './platform/crypto.js';
import { Accounts } from './platform/accounts.js';
import { JsonDb } from './platform/db.js';
import { DockerExecutor, LocalExecutor } from './platform/executor.js';
import { LocalRepo, RepoRegistry } from './platform/repos.js';
import { inProcessExecutor, startServer } from './server.js';
import { formatStatus } from './report.js';
import { createRunner } from './runner.js';
import { RunStore } from './store.js';
import type { RunEvent, RunOptions, RunSource, RunState } from './types.js';
import { truncate } from './util.js';

const program = new Command();
program
  .name('agentpool')
  .description('Run a pool of role-based agents on a task and get back a reviewed branch and a merge request description.')
  .version('0.3.0');

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function handle<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (e) {
      fail((e as Error).message);
    }
  };
}

async function resolveRepo(path: string | undefined): Promise<string> {
  const dir = resolve(path ?? '.');
  if (!(await isGitRepo(dir))) fail(`${dir} is not inside a git repository`);
  return gitRoot(dir);
}

const isTty = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

async function setup(opts: { repo?: string; runner: 'claude' | 'dry-run'; interactive: boolean }) {
  const root = await resolveRepo(opts.repo);
  const store = new RunStore(root);
  const orchestrator = new Orchestrator({
    repoRoot: root,
    store,
    runner: createRunner(opts.runner),
    agents: loadAgents(root),
    channel: opts.interactive ? new TerminalChannel() : new NullChannel(),
    repoConfig: loadRepoConfig(root),
    log: (line) => console.log(line),
  });
  return { root, store, orchestrator };
}

function pickRun(store: RunStore, id: string | undefined): string {
  const runId = id ?? store.latest();
  if (!runId) fail('No runs found in this repository. Start one with `agentpool run`.');
  if (!store.exists(runId)) fail(`No run with id ${runId}`);
  return runId;
}

function num(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) fail(`${name} must be a positive number`);
  return n;
}

function keyNote(kind: 'claude' | 'dry-run'): void {
  if (kind === 'claude' && !process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.log('note: ANTHROPIC_API_KEY is not set. The agents will use an existing Claude Code login if there is one.');
  }
}

/** After a run stops: open the pull request when the run asked for it. A failure here never fails the run itself. */
async function afterDrive(root: string, store: RunStore, state: RunState): Promise<RunState> {
  if (state.phase !== 'done') return state;
  const deps = { repoRoot: root, store, config: loadRepoConfig(root) };
  if (state.options.openPr && !state.pr) {
    try {
      const r = await openPullRequest(deps, state.id, { draft: state.options.draft });
      console.log(`\n${r.host === 'github' ? 'Pull request' : 'Merge request'}${r.existing ? ' (already existed)' : ''}${r.draft ? ' (draft)' : ''}: ${r.url}`);
    } catch (e) {
      console.error(`\nThe run is done, but opening the request failed: ${(e as Error).message}\nFix that, then run: agentpool pr ${state.id}`);
      process.exitCode = 1;
    }
  }
  const fresh = store.state(state.id);
  if (fresh.options.jiraComment && fresh.pr && fresh.source && !fresh.jiraCommented) {
    try {
      await commentOnJira(deps, fresh.id);
      console.log(`Commented on ${fresh.source.key}.`);
    } catch (e) {
      console.error(`Could not comment on ${fresh.source.key}: ${(e as Error).message}\nRetry with: agentpool pr ${fresh.id} --jira-comment`);
      process.exitCode = 1;
    }
  }
  return store.state(state.id);
}

program
  .command('run')
  .description('Start a pool on a task, typed here or read from a file')
  .argument('[task...]', 'the task, as text')
  .option('-t, --task <text>', 'the task, as text')
  .option('-f, --task-file <path>', 'read the task from a file')
  .option('--repo <path>', 'repository to work on', '.')
  .option('--base <ref>', 'branch or commit to start from (default: the current HEAD)')
  .option('--autonomy <mode>', 'plan-approval (ask before building) or auto')
  .option('--runner <kind>', 'claude or dry-run (fake agents, no cost)', 'claude')
  .option('--model <id>', 'model for every agent that does not set its own')
  .option('--max-rounds <n>', 'build rounds before asking a person (default 2)')
  .option('--budget-usd <n>', 'stop the run after this much spend (default 10)')
  .option('--agent-budget-usd <n>', 'spend limit for a single agent step (default 3)')
  .option('--assume-defaults', 'never wait: take the recommended answer and finish flagged if stuck')
  .option('--jira <key|url>', 'take the task from a Jira Cloud issue (PROJ-123 or its URL); any task text is added as extra instructions')
  .option('--open-pr', 'when the run finishes, push the branch and open a pull / merge request (GitHub or GitLab)')
  .option('--draft', 'open it as a draft (default: draft unless the run is ready for review)')
  .option('--no-draft', 'open it ready for review even if the run flagged problems')
  .option('--jira-comment', 'after opening the request, comment on the Jira issue with the link')
  .option('--skip-baseline', 'skip installing dependencies and the baseline test run')
  .option('--no-interactive', 'never prompt; park the run and wait for answer/approve instead')
  .action(
    handle(async (taskWords: string[], o) => {
      const typed = (o.task ?? (o.taskFile ? readFileSync(resolve(o.taskFile), 'utf8') : taskWords.join(' '))).trim();
      if (!typed && !o.jira) fail('Give a task: agentpool run "Add CSV export to the reports page"  (or --jira PROJ-123)');
      if (o.jiraComment && !o.jira) fail('--jira-comment needs --jira');
      if (o.jiraComment && !o.openPr) fail('--jira-comment links the pull request, so it needs --open-pr');
      if (o.runner !== 'claude' && o.runner !== 'dry-run') fail('--runner must be claude or dry-run');
      const interactive = o.interactive !== false && isTty() && !o.assumeDefaults;
      const { root, store, orchestrator } = await setup({ repo: o.repo, runner: o.runner, interactive });
      const cfg = loadRepoConfig(root);
      let task = typed;
      let source: RunSource | undefined;
      if (o.jira) {
        const ref = parseJiraRef(o.jira);
        const auth = resolveJiraAuth({ urlBase: ref.baseUrl, configBase: cfg.jira.baseUrl });
        const issue = await fetchIssue(ref.key, auth);
        ({ task, source } = taskFromIssue(issue, typed));
        console.log(`Imported ${issue.key}: ${truncate(issue.summary, 80)}`);
      }
      if (await isDirty(root)) {
        console.log('note: the repository has uncommitted changes. Agents work from the last commit and will not see them.');
      }
      keyNote(o.runner);
      const options: RunOptions = {
        autonomy: o.autonomy ?? cfg.autonomy ?? 'plan-approval',
        maxRounds: num(o.maxRounds, '--max-rounds') ?? cfg.maxRounds ?? 2,
        budgetUsd: num(o.budgetUsd, '--budget-usd') ?? cfg.budgetUsd ?? 10,
        agentBudgetUsd: num(o.agentBudgetUsd, '--agent-budget-usd') ?? cfg.agentBudgetUsd ?? 3,
        assumeDefaults: Boolean(o.assumeDefaults),
        runner: o.runner,
        model: o.model ?? cfg.model,
        skipBaseline: Boolean(o.skipBaseline),
        ...(o.openPr ? { openPr: true } : {}),
        ...(o.draft !== undefined ? { draft: Boolean(o.draft) } : {}),
        ...(o.jiraComment ? { jiraComment: true } : {}),
      };
      if (options.autonomy !== 'plan-approval' && options.autonomy !== 'auto') fail('--autonomy must be plan-approval or auto');
      const id = await orchestrator.startRun({ task, options, base: o.base, source });
      console.log(`Started run ${id}\n`);
      const state = await afterDrive(root, store, await orchestrator.drive(id));
      console.log(`\n${formatStatus(state)}`);
      if (state.lastError || state.phase === 'failed' || state.phase === 'rejected') process.exitCode = 1;
    }),
  );

program
  .command('resume')
  .description('Continue a run that is parked, failed a step, or was interrupted')
  .argument('[run-id]', 'defaults to the latest run')
  .option('--repo <path>', 'repository', '.')
  .option('--runner <kind>', 'override the runner stored with the run')
  .option('--no-interactive', 'never prompt')
  .action(
    handle(async (runId: string | undefined, o) => {
      const root = await resolveRepo(o.repo);
      const store = new RunStore(root);
      const id = pickRun(store, runId);
      const stored = store.state(id);
      const kind = (o.runner ?? stored.options.runner) as 'claude' | 'dry-run';
      if (kind !== 'claude' && kind !== 'dry-run') fail('--runner must be claude or dry-run');
      const { orchestrator } = await setup({ repo: root, runner: kind, interactive: o.interactive !== false && isTty() && !stored.options.assumeDefaults });
      keyNote(kind);
      const state = await afterDrive(root, store, await orchestrator.drive(id));
      console.log(`\n${formatStatus(state)}`);
      if (state.lastError || state.phase === 'failed' || state.phase === 'rejected') process.exitCode = 1;
    }),
  );

program
  .command('status')
  .description('Show where a run is and what it is waiting for')
  .argument('[run-id]', 'defaults to the latest run')
  .option('--repo <path>', 'repository', '.')
  .action(
    handle(async (runId: string | undefined, o) => {
      const root = await resolveRepo(o.repo);
      const store = new RunStore(root);
      console.log(formatStatus(store.state(pickRun(store, runId))));
    }),
  );

program
  .command('list')
  .description('List runs in this repository')
  .option('--repo <path>', 'repository', '.')
  .action(
    handle(async (o) => {
      const root = await resolveRepo(o.repo);
      const store = new RunStore(root);
      const ids = store.list();
      if (ids.length === 0) return console.log('No runs yet.');
      for (const id of ids) {
        const s = store.state(id);
        console.log(`${id}  ${s.phase.padEnd(24)} ${truncate(s.task.replace(/\s+/g, ' '), 60)}`);
      }
    }),
  );

program
  .command('pr')
  .description('Push the run branch and open a pull request (GitHub) or merge request (GitLab)')
  .argument('[run-id]', 'defaults to the latest run')
  .option('--repo <path>', 'repository', '.')
  .option('--remote <name>', 'git remote to push to (default: origin)')
  .option('--host <kind>', 'github or gitlab, for self-hosted servers whose name does not say')
  .option('--draft', 'open as a draft (default: draft unless the run is ready for review)')
  .option('--no-draft', 'open ready for review even if the run flagged problems')
  .option('--jira-comment', 'comment on the Jira issue with the link')
  .option('--dry-run', 'show what would be pushed and opened, without doing it')
  .action(
    handle(async (runId: string | undefined, o) => {
      const root = await resolveRepo(o.repo);
      const store = new RunStore(root);
      const id = pickRun(store, runId);
      if (o.host && o.host !== 'github' && o.host !== 'gitlab') fail('--host must be github or gitlab');
      const deps = { repoRoot: root, store, config: loadRepoConfig(root) };
      const r = await openPullRequest(deps, id, { remote: o.remote, host: o.host as HostKind | undefined, draft: o.draft, dryRun: Boolean(o.dryRun) });
      const noun = r.host === 'github' ? 'pull request' : 'merge request';
      if (r.dryRun) {
        const s = store.state(id);
        console.log(`Would push ${s.branch} to ${r.remote} and open a ${r.draft ? 'draft ' : ''}${noun} into ${s.baseBranch} on ${r.host}.\nTitle: ${r.title}`);
      } else {
        console.log(`${r.existing ? `A ${noun} already exists` : `Opened ${noun}`}${r.draft ? ' (draft)' : ''}: ${r.url}`);
      }
      if (o.jiraComment && !r.dryRun) {
        console.log((await commentOnJira(deps, id)) ? 'Commented on the Jira issue.' : 'The Jira issue was already commented on.');
      }
    }),
  );

program
  .command('jira')
  .description('Preview a Jira Cloud issue as the task a run would get (nothing is started)')
  .argument('<key|url>', 'PROJ-123 or the issue URL')
  .option('--repo <path>', 'repository', '.')
  .action(
    handle(async (ref: string, o) => {
      const root = await resolveRepo(o.repo);
      const parsed = parseJiraRef(ref);
      const auth = resolveJiraAuth({ urlBase: parsed.baseUrl, configBase: loadRepoConfig(root).jira.baseUrl });
      const issue = await fetchIssue(parsed.key, auth);
      console.log(taskFromIssue(issue).task);
      console.log(`\n(${issue.url})`);
    }),
  );

program
  .command('work')
  .description('Drive one run to its next stopping point with no prompts and no follow-up actions (used by the server inside containers)')
  .argument('<run-id>')
  .option('--repo <path>', 'repository', '.')
  .action(
    handle(async (runId: string, o) => {
      const root = await resolveRepo(o.repo);
      const store = new RunStore(root);
      if (!store.exists(runId)) fail(`No run with id ${runId}`);
      const kind = store.state(runId).options.runner;
      const { orchestrator } = await setup({ repo: root, runner: kind, interactive: false });
      const state = await orchestrator.drive(runId);
      console.log(`stopped in phase ${state.phase}${state.lastError ? ` (error: ${state.lastError})` : ''}`);
    }),
  );

program
  .command('serve')
  .description('Start the local web app for the repository you are in (single user, localhost only)')
  .option('--repo <path>', 'repository', '.')
  .option('--port <n>', 'port to listen on (default 4317)', '4317')
  .action(
    handle(async (o) => {
      const root = await resolveRepo(o.repo);
      const port = Number(o.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail('--port must be a number between 0 and 65535');
      const cli = join(PACKAGE_ROOT, 'dist', 'cli.js');
      const executor = existsSync(cli) ? new LocalExecutor() : inProcessExecutor({});
      const running = await startServer({ repos: new LocalRepo(root, basename(root)), executor, port });
      console.log(`agentpool web app for ${root}\n  ${running.url}\nListening on 127.0.0.1 only. Press Ctrl+C to stop; tasks in progress stop with it and continue with \`agentpool resume\`.`);
      await new Promise<void>((done) => {
        process.once('SIGINT', done);
        process.once('SIGTERM', done);
      });
      await running.close();
    }),
  );

const envNum = (v: string | undefined, name: string): number | undefined => num(v, name);

program
  .command('server')
  .description('Start the team server: accounts, connected repositories, one container per task')
  .option('--data-dir <path>', 'where accounts, tokens and clones live (env AGENTPOOL_DATA_DIR)')
  .option('--port <n>', 'port (env AGENTPOOL_PORT, default 4317)')
  .option('--host <addr>', 'address to listen on (env AGENTPOOL_HOST, default 127.0.0.1)')
  .option('--public-url <url>', 'the https URL people use, behind your TLS proxy (env AGENTPOOL_PUBLIC_URL)')
  .option('--executor <kind>', 'docker (default) or local (no isolation, trusted teams only) (env AGENTPOOL_EXECUTOR)')
  .option('--image <name>', 'worker image for the docker executor (env AGENTPOOL_IMAGE)', 'agentpool-worker')
  .option('--worker-network <name>', 'docker network for workers (env AGENTPOOL_WORKER_NETWORK)')
  .option('--worker-cpus <n>', 'CPUs per task container', '2')
  .option('--worker-memory <size>', 'memory per task container', '4g')
  .option('--concurrency <n>', 'tasks running at once (env AGENTPOOL_CONCURRENCY, default 2)')
  .option('--timeout-minutes <n>', 'stop a task that runs longer than this (default 60)')
  .option('--max-budget-usd <n>', 'upper limit anyone can set for one task (env AGENTPOOL_MAX_BUDGET_USD)')
  .action(
    handle(async (o) => {
      const env = process.env;
      const dataDir = resolve(o.dataDir ?? env.AGENTPOOL_DATA_DIR ?? './agentpool-data');
      const host = o.host ?? env.AGENTPOOL_HOST ?? '127.0.0.1';
      const port = Number(o.port ?? env.AGENTPOOL_PORT ?? 4317);
      const publicUrl: string | undefined = o.publicUrl ?? env.AGENTPOOL_PUBLIC_URL;
      const kind: string = o.executor ?? env.AGENTPOOL_EXECUTOR ?? 'docker';
      if (kind !== 'docker' && kind !== 'local') fail('--executor must be docker or local');
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail('--port must be a number between 0 and 65535');
      if (publicUrl && !/^https?:\/\//.test(publicUrl)) fail('--public-url must start with http:// or https://');
      const image: string = o.image ?? env.AGENTPOOL_IMAGE ?? 'agentpool-worker';
      let executor;
      if (kind === 'docker') {
        const probe = (args: string[]) => new Promise<string | null>((done) => execFile('docker', args, (err, out, errOut) => done(err ? String(errOut || err.message).trim() : null)));
        const down = await probe(['version', '--format', '{{.Server.Version}}']);
        if (down) fail(`Docker is not reachable: ${down.split('\n')[0]}\nInstall and start Docker, or use --executor local on a machine you trust.`);
        if (await probe(['image', 'inspect', image])) fail(`The worker image "${image}" does not exist. Build it with: docker build -t ${image} .`);
        executor = new DockerExecutor({ image, cpus: o.workerCpus, memory: o.workerMemory, network: o.workerNetwork ?? env.AGENTPOOL_WORKER_NETWORK });
      } else {
        if (!existsSync(join(PACKAGE_ROOT, 'dist', 'cli.js'))) fail('Run `npm run build` first: the local executor starts workers from dist/.');
        executor = new LocalExecutor();
        console.log('warning: the local executor runs agents directly on this machine with no isolation. Use it only for a team you trust.');
      }
      const db = new JsonDb(dataDir);
      const registry = new RepoRegistry({ dataDir, db, key: loadMasterKey(dataDir), gitName: env.AGENTPOOL_GIT_NAME, gitEmail: env.AGENTPOOL_GIT_EMAIL });
      const accounts = new Accounts(db);
      const running = await startServer({
        repos: registry,
        registry,
        accounts,
        executor,
        port,
        host,
        publicUrl,
        concurrency: envNum(o.concurrency ?? env.AGENTPOOL_CONCURRENCY, '--concurrency'),
        timeoutMs: (envNum(o.timeoutMinutes, '--timeout-minutes') ?? 60) * 60_000,
        maxBudgetUsd: envNum(o.maxBudgetUsd ?? env.AGENTPOOL_MAX_BUDGET_USD, '--max-budget-usd'),
      });
      console.log(`agentpool team server (${executor.name} executor)\n  ${running.url}\n  data: ${dataDir}`);
      if (!accounts.hasUsers()) console.log('No accounts yet: open the URL and create the admin account.');
      if (host !== '127.0.0.1' && host !== 'localhost' && !publicUrl?.startsWith('https://')) {
        console.log('warning: listening beyond localhost without an https public URL. Put a TLS proxy in front, or passwords and sessions travel in clear text.');
      }
      if (!env.ANTHROPIC_API_KEY) console.log('note: ANTHROPIC_API_KEY is not set. Workers have no other Claude login, so real runs will fail until it is.');
      await new Promise<void>((done) => {
        process.once('SIGINT', done);
        process.once('SIGTERM', done);
      });
      await running.close();
    }),
  );

program
  .command('doctor')
  .description('Check that this machine and repository are ready for agentpool')
  .option('--repo <path>', 'repository', '.')
  .action(
    handle(async (o) => {
      let hard = 0;
      const line = (mark: 'ok' | 'warn' | 'FAIL', what: string, detail = '') => {
        if (mark === 'FAIL') hard++;
        console.log(`${mark.padEnd(4)}  ${what}${detail ? `  ${detail}` : ''}`);
      };
      const major = Number(process.versions.node.split('.')[0]);
      major >= 20 ? line('ok', 'Node', process.versions.node) : line('FAIL', 'Node', `${process.versions.node}; agentpool needs 20 or newer`);
      try {
        line('ok', 'git', (await git(process.cwd(), ['--version'])).trim());
      } catch {
        line('FAIL', 'git', 'not found on PATH');
      }
      const dir = resolve(o.repo ?? '.');
      if (!(await isGitRepo(dir))) {
        line('FAIL', 'repository', `${dir} is not inside a git repository`);
        process.exitCode = 1;
        return;
      }
      const root = await gitRoot(dir);
      line('ok', 'repository', root);
      (await hasCommits(root)) ? line('ok', 'commits', 'at least one commit') : line('FAIL', 'commits', 'none yet; agents need something to branch from');

      let cfg: ReturnType<typeof loadRepoConfig> | undefined;
      try {
        cfg = loadRepoConfig(root);
        line('ok', 'config', '.agentpool/config.json is valid or absent');
      } catch (e) {
        line('FAIL', 'config', (e as Error).message);
      }
      try {
        const agents = loadAgents(root);
        line('ok', 'agents', [...agents.keys()].join(', '));
      } catch (e) {
        line('FAIL', 'agents', (e as Error).message);
      }
      const profile = detectProfile(root, cfg?.commands);
      profile.commands.test
        ? line('ok', 'tests', `will run \`${profile.commands.test}\``)
        : line('warn', 'tests', 'no test command detected; set commands.test in .agentpool/config.json so the run can verify QA');

      process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN
        ? line('ok', 'Claude credentials', 'found in the environment')
        : line('warn', 'Claude credentials', 'no ANTHROPIC_API_KEY; an existing Claude Code login will be used if there is one');

      const remote = cfg?.git.remote ?? 'origin';
      try {
        const url = (await git(root, ['remote', 'get-url', remote])).trim();
        try {
          const ref = detectHost(url, { host: cfg?.git.host, apiUrl: cfg?.git.apiUrl });
          line('ok', `remote ${remote}`, `${ref.kind} at ${ref.hostname}, project ${ref.project}`);
          const tok = resolveToken(ref.kind);
          tok ? line('ok', `${ref.kind} token`, `from ${tok.source}`) : line('warn', `${ref.kind} token`, `none found; \`agentpool pr\` will not work until you set ${ref.kind === 'github' ? 'GITHUB_TOKEN' : 'GITLAB_TOKEN'}`);
        } catch (e) {
          line('warn', `remote ${remote}`, (e as Error).message);
        }
      } catch {
        line('warn', `remote ${remote}`, 'not set; runs still work, but `agentpool pr` needs a remote');
      }

      await new Promise<void>((done) =>
        execFile('docker', ['version', '--format', '{{.Server.Version}}'], (err, out) => {
          if (err) line('warn', 'docker', 'not reachable; `agentpool server` needs it (or --executor local)');
          else {
            line('ok', 'docker', `server ${out.trim()}`);
            execFile('docker', ['image', 'inspect', 'agentpool-worker'], (e2) => {
              e2 ? line('warn', 'worker image', 'agentpool-worker not built: docker build -t agentpool-worker .') : line('ok', 'worker image', 'agentpool-worker');
              done();
            });
            return;
          }
          done();
        }),
      );

      const jiraBits = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'].filter((k) => process.env[k]);
      jiraBits.length === 3
        ? line('ok', 'Jira', 'JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN are set')
        : line('warn', 'Jira', `${jiraBits.length === 0 ? 'not configured (optional)' : `partly set: have ${jiraBits.join(', ')}`}`);
      if (hard > 0) process.exitCode = 1;
    }),
  );

function describeEvent(e: RunEvent): string {
  switch (e.type) {
    case 'run.created':
      return `created on ${e.branch}`;
    case 'profile.detected':
      return `profile: ${e.profile.languages.join(', ') || 'unknown'}; test: ${e.profile.commands.test ?? 'none'}`;
    case 'baseline.completed':
      return e.result ? `baseline ${e.result.exitCode === 0 ? 'passed' : `failed (exit ${e.result.exitCode})`}` : 'no baseline';
    case 'plan.proposed':
      return `plan round ${e.round}: ${truncate(e.plan.summary, 90)}`;
    case 'question.raised':
      return `${e.id}${e.blocking ? ' (blocking)' : ''}: ${truncate(e.text, 90)}`;
    case 'question.answered':
      return `${e.id} answered${e.viaDefault ? ' by default' : ''}: ${truncate(e.answer, 80)}`;
    case 'gate.decided':
      return `${e.gate} gate ${e.approved ? 'approved' : 'rejected'}${e.note ? ` (${e.note})` : ''}`;
    case 'step.started':
      return `${e.step} started, round ${e.round}`;
    case 'step.finished':
      return `${e.step} finished, round ${e.round}, $${e.costUsd.toFixed(2)}`;
    case 'message.posted':
      return `${e.message.type} ${e.message.from} -> ${e.message.to} [${e.message.thread}]: ${truncate(e.message.body, 80)}`;
    case 'dev.result':
      return `build round ${e.round}: ${truncate(e.result.summary, 90)}${e.commit ? ` (${e.commit})` : ''}`;
    case 'qa.result':
      return `qa round ${e.round}: ${e.result.verdict}${e.agentVerdict !== e.result.verdict ? ` (agent said ${e.agentVerdict})` : ''}`;
    case 'review.result':
      return `review round ${e.round}: ${e.result.verdict}, ${e.result.findings.length} finding(s)`;
    case 'scope.violation':
      return `${e.step} wrote outside its scope, reverted: ${e.paths.join(', ')}`;
    case 'phase.changed':
      return `phase -> ${e.phase}`;
    case 'run.error':
      return `error: ${e.message}`;
    case 'pr.opened':
      return `${e.host === 'github' ? 'pull request' : 'merge request'} ${e.existing ? 'already existed' : 'opened'}${e.draft ? ' (draft)' : ''}: ${e.url}`;
    case 'jira.commented':
      return `commented on ${e.key}`;
    case 'run.finished':
      return `finished: ${e.outcome}${e.reason ? ` (${e.reason})` : ''}`;
  }
}

program
  .command('log')
  .description('Show the full event history of a run')
  .argument('[run-id]', 'defaults to the latest run')
  .option('--repo <path>', 'repository', '.')
  .option('--json', 'print raw JSON lines')
  .action(
    handle(async (runId: string | undefined, o) => {
      const root = await resolveRepo(o.repo);
      const store = new RunStore(root);
      for (const e of store.events(pickRun(store, runId))) {
        if (o.json) console.log(JSON.stringify(e));
        else console.log(`#${String(e.seq).padStart(3, '0')} ${e.ts.slice(11, 19)} ${`${e.actor.type}:${e.actor.id}`.padEnd(22)} ${describeEvent(e)}`);
      }
    }),
  );

program
  .command('answer')
  .description('Answer a question an agent asked')
  .argument('<run-id>')
  .argument('<question-id>')
  .argument('<answer...>')
  .option('--repo <path>', 'repository', '.')
  .action(
    handle(async (runId: string, questionId: string, words: string[], o) => {
      const { orchestrator, store } = await setup({ repo: o.repo, runner: 'dry-run', interactive: false });
      pickRun(store, runId);
      orchestrator.answerQuestion(runId, questionId, words.join(' '));
      console.log(`Recorded your answer to ${questionId}. Continue with: agentpool resume ${runId}`);
    }),
  );

for (const [name, approved] of [['approve', true], ['reject', false]] as const) {
  program
    .command(name)
    .description(approved ? 'Approve the plan, or finish a stuck run flagged as not ready' : 'Reject the plan, or stop a stuck run')
    .argument('<run-id>')
    .argument('[reason...]')
    .option('--repo <path>', 'repository', '.')
    .action(
      handle(async (runId: string, reason: string[], o) => {
        const { orchestrator, store } = await setup({ repo: o.repo, runner: 'dry-run', interactive: false });
        pickRun(store, runId);
        const gate = orchestrator.decideGate(runId, approved, reason.join(' ') || undefined);
        console.log(`Recorded: ${gate} ${approved ? 'approved' : 'rejected'}. Continue with: agentpool resume ${runId}`);
      }),
    );
}

program
  .command('clean')
  .description('Remove the worktree of a finished run (the branch is kept)')
  .argument('<run-id>')
  .option('--repo <path>', 'repository', '.')
  .action(
    handle(async (runId: string, o) => {
      const { orchestrator, store } = await setup({ repo: o.repo, runner: 'dry-run', interactive: false });
      pickRun(store, runId);
      await orchestrator.cleanWorktree(runId);
      console.log('Worktree removed. The branch is still there.');
    }),
  );

program
  .command('agents')
  .description('List the agents that would run here, including repo overrides')
  .option('--repo <path>', 'repository', '.')
  .action(
    handle(async (o) => {
      const root = await resolveRepo(o.repo);
      for (const a of loadAgents(root).values()) {
        console.log(`${a.name.padEnd(10)} ${a.source.padEnd(8)} tools: ${a.tools.join(', ') || 'none'}`);
        console.log(`${' '.repeat(10)} role: ${a.role}`);
        console.log(`${' '.repeat(10)} may write: ${a.writeScope.length ? a.writeScope.join(', ') : 'nothing (read-only)'}`);
        console.log(`${' '.repeat(10)} skills: ${a.skills.join(', ') || 'none'}`);
      }
    }),
  );

await program.parseAsync(process.argv);
