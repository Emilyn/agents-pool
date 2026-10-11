#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { NullChannel, TerminalChannel } from './channel.js';
import { loadAgents, loadRepoConfig } from './config.js';
import { isGitRepo, isDirty, repoRoot as gitRoot } from './git.js';
import { Orchestrator } from './orchestrator.js';
import { formatStatus } from './report.js';
import { createRunner } from './runner.js';
import { RunStore } from './store.js';
import type { RunEvent, RunOptions } from './types.js';
import { truncate } from './util.js';

const program = new Command();
program
  .name('agentpool')
  .description('Run a pool of role-based agents on a task and get back a reviewed branch and a merge request description.')
  .version('0.1.0');

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
  .option('--skip-baseline', 'skip installing dependencies and the baseline test run')
  .option('--no-interactive', 'never prompt; park the run and wait for answer/approve instead')
  .action(
    handle(async (taskWords: string[], o) => {
      const task = (o.task ?? (o.taskFile ? readFileSync(resolve(o.taskFile), 'utf8') : taskWords.join(' '))).trim();
      if (!task) fail('Give a task: agentpool run "Add CSV export to the reports page"');
      if (o.runner !== 'claude' && o.runner !== 'dry-run') fail('--runner must be claude or dry-run');
      const interactive = o.interactive !== false && isTty() && !o.assumeDefaults;
      const { root, orchestrator } = await setup({ repo: o.repo, runner: o.runner, interactive });
      const cfg = loadRepoConfig(root);
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
      };
      if (options.autonomy !== 'plan-approval' && options.autonomy !== 'auto') fail('--autonomy must be plan-approval or auto');
      const id = await orchestrator.startRun({ task, options, base: o.base });
      console.log(`Started run ${id}\n`);
      const state = await orchestrator.drive(id);
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
      const state = await orchestrator.drive(id);
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
