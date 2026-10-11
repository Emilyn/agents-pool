import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NullChannel } from '../src/channel.js';
import { loadAgents, loadRepoConfig } from '../src/config.js';
import { Orchestrator } from '../src/orchestrator.js';
import type { AgentOutcome, AgentRequest, AgentRunner } from '../src/runner.js';
import { RunStore } from '../src/store.js';
import type { RunOptions } from '../src/types.js';

export function makeRepo(files: Record<string, string> = { 'README.md': '# sample\n' }): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentpool-test-'));
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  run('add', '-A');
  run('commit', '-q', '-m', 'initial');
  return dir;
}

export const fenced = (o: unknown): string => `Done.\n\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

export const PLAN = {
  summary: 'Add a greeting file',
  steps: ['Create greeting.txt'],
  acceptanceCriteria: ['greeting.txt exists'],
  risks: [],
  assumptions: ['English is fine'],
  questions: [] as unknown[],
};
export const DEV = { summary: 'Created greeting.txt', filesChanged: ['greeting.txt'], testsRun: 'none', assumptions: [], unsure: [] };
export const QA_PASS = { verdict: 'pass', checks: [{ criterion: 'greeting.txt exists', status: 'pass', evidence: 'ls' }], issues: [], testsAdded: [] };
export const REVIEW_OK = { verdict: 'approve', findings: [], unsure: [] };

type Reply = string | { error: string };
export type Handler = (req: AgentRequest, n: number) => Reply | Promise<Reply>;

/** An agent runner driven by test code instead of a model. */
export class ScriptedRunner implements AgentRunner {
  calls: AgentRequest[] = [];
  constructor(private readonly handlers: Record<string, Handler>) {}

  count(role: string): number {
    return this.calls.filter((c) => c.role === role).length;
  }

  async run(req: AgentRequest): Promise<AgentOutcome> {
    this.calls.push(req);
    const handler = this.handlers[req.role];
    if (!handler) throw new Error(`no scripted handler for ${req.role}`);
    const reply = await handler(req, this.count(req.role));
    const base = { costUsd: 0.01, turns: 1, durationMs: 5 };
    if (typeof reply === 'object') return { ...base, text: '', isError: true, errorKind: reply.error };
    return { ...base, text: reply, isError: false };
  }
}

export const defaultOptions = (over: Partial<RunOptions> = {}): RunOptions => ({
  autonomy: 'auto',
  maxRounds: 2,
  budgetUsd: 10,
  agentBudgetUsd: 3,
  assumeDefaults: false,
  runner: 'dry-run',
  skipBaseline: true,
  ...over,
});

export function makeOrchestrator(repo: string, runner: AgentRunner, log?: (l: string) => void) {
  const store = new RunStore(repo);
  const orchestrator = new Orchestrator({
    repoRoot: repo,
    store,
    runner,
    agents: loadAgents(repo),
    channel: new NullChannel(),
    repoConfig: loadRepoConfig(repo),
    log,
  });
  return { store, orchestrator };
}
