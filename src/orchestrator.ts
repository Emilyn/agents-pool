import { join } from 'node:path';
import type { z } from 'zod';
import type { HumanChannel } from './channel.js';
import type { AgentDef, RepoConfig } from './config.js';
import {
  addWorktree,
  commitAll,
  commitLog,
  currentBranch,
  diffStat,
  discardPaths,
  ensureExcluded,
  git,
  hasCommits,
  removeWorktree,
  resolveCommit,
  stagedPaths,
} from './git.js';
import { buildMrDescription } from './mr.js';
import { parseStructured } from './parse.js';
import { detectProfile } from './profile.js';
import {
  developerPrompt,
  plannerPrompt,
  qaPrompt,
  repairPrompt,
  reviewerPrompt,
} from './prompts.js';
import type { AgentRequest, AgentRunner } from './runner.js';
import { pathAllowed } from './scope.js';
import { runCommand } from './shell.js';
import type { RunStore } from './store.js';
import {
  DevResultSchema,
  PlanSchema,
  QaResultSchema,
  ReviewResultSchema,
  TERMINAL_PHASES,
  type Actor,
  type CommandResult,
  type EventBody,
  type MessageType,
  type Phase,
  type QaResult,
  type RunOptions,
  type RunState,
  type StepName,
  type RunSource,
} from './types.js';
import { firstLine, formatUsd, newRunId, truncate } from './util.js';

const SYSTEM: Actor = { type: 'system', id: 'orchestrator' };
const human = (): Actor => ({ type: 'human', id: process.env.USER ?? process.env.USERNAME ?? 'user' });
const agent = (step: StepName): Actor => ({ type: 'agent', id: step });

/** Only the first planning round may park the run on questions. Later rounds must commit to a plan. */
const MAX_PLAN_ROUNDS = 2;

export interface OrchestratorDeps {
  repoRoot: string;
  store: RunStore;
  runner: AgentRunner;
  agents: Map<string, AgentDef>;
  channel: HumanChannel;
  repoConfig: RepoConfig;
  log?: (line: string) => void;
}

/**
 * Drives a run through plan, approval, build, QA, review and the merge request description.
 *
 * Every transition is an event in the run's log and `drive` always starts from the log, so a run can be
 * interrupted at any point, parked on a question or approval, and resumed later. Agents never talk to
 * each other directly: they return typed results, and the orchestrator turns them into messages and
 * briefs for the next agent.
 */
export class Orchestrator {
  constructor(private readonly d: OrchestratorDeps) {}

  private log(line: string): void {
    this.d.log?.(line);
  }

  private ev(id: string, actor: Actor, body: EventBody): void {
    this.d.store.append(id, actor, body);
  }

  private setPhase(id: string, phase: Phase): void {
    this.ev(id, SYSTEM, { type: 'phase.changed', phase });
  }

  private post(
    id: string,
    m: { type: MessageType; from: string; to: string; thread: string; round: number; body: string },
  ): void {
    const n = this.d.store.state(id).messages.length + 1;
    const actor: Actor = m.from === 'human' ? human() : m.from === 'orchestrator' ? SYSTEM : { type: 'agent', id: m.from };
    this.ev(id, actor, { type: 'message.posted', message: { id: `M-${n}`, ...m } });
  }

  private finish(id: string, outcome: 'done' | 'failed' | 'rejected', reason?: string, mrFile?: string): void {
    this.ev(id, SYSTEM, { type: 'run.finished', outcome, reason, mrFile });
  }

  /* ---------- Starting a run ---------- */

  async startRun(input: { task: string; options: RunOptions; base?: string; source?: RunSource }): Promise<string> {
    const { repoRoot, store } = this.d;
    if (!(await hasCommits(repoRoot))) {
      throw new Error('This repository has no commits yet. Make an initial commit so agents have something to branch from.');
    }
    const id = newRunId();
    const baseBranch = input.base ?? (await currentBranch(repoRoot));
    const baseCommit = await resolveCommit(repoRoot, input.base ?? 'HEAD');
    const branch = `agentpool/${id}`;
    const worktree = join(repoRoot, '.agentpool', 'worktrees', id);
    await ensureExcluded(repoRoot, ['.agentpool/runs/', '.agentpool/worktrees/']);
    await addWorktree(repoRoot, worktree, branch, baseCommit);
    this.ev(id, SYSTEM, {
      type: 'run.created',
      runId: id,
      task: input.task,
      repo: repoRoot,
      baseBranch,
      baseCommit,
      branch,
      worktree,
      options: input.options,
      source: input.source,
    });
    return id;
  }

  /* ---------- Human actions (called by the CLI) ---------- */

  answerQuestion(runId: string, questionId: string, answer: string): void {
    const s = this.d.store.state(runId);
    const q = s.questions.find((x) => x.id === questionId);
    if (!q) throw new Error(`Run ${runId} has no question ${questionId}`);
    if (q.answer !== undefined) throw new Error(`${questionId} is already answered`);
    this.recordAnswer(s, questionId, answer, false);
  }

  decideGate(runId: string, approved: boolean, note?: string): 'plan' | 'escalation' {
    const s = this.d.store.state(runId);
    if (s.phase === 'awaiting_plan_approval') {
      this.ev(runId, human(), { type: 'gate.decided', gate: 'plan', approved, note });
      return 'plan';
    }
    if (s.phase === 'awaiting_escalation') {
      this.ev(runId, human(), { type: 'gate.decided', gate: 'escalation', approved, note });
      return 'escalation';
    }
    throw new Error(`Run ${runId} is in phase "${s.phase}", which is not waiting for approval`);
  }

  async cleanWorktree(runId: string): Promise<void> {
    const s = this.d.store.state(runId);
    await removeWorktree(this.d.repoRoot, s.worktree);
  }

  private recordAnswer(s: RunState, questionId: string, answer: string, viaDefault: boolean): void {
    const actor = viaDefault ? SYSTEM : human();
    this.ev(s.id, actor, { type: 'question.answered', id: questionId, answer, viaDefault });
    const q = s.questions.find((x) => x.id === questionId);
    this.post(s.id, {
      type: 'decision',
      from: viaDefault ? 'orchestrator' : 'human',
      to: 'all',
      thread: questionId,
      round: s.planRound,
      body: `${q?.text ?? questionId} -> ${answer}`,
    });
  }

  /* ---------- The loop ---------- */

  async drive(runId: string): Promise<RunState> {
    for (;;) {
      const s = this.d.store.state(runId);
      if (TERMINAL_PHASES.includes(s.phase)) return s;
      if (s.costUsd >= s.options.budgetUsd) {
        this.finish(runId, 'failed', `Run budget of ${formatUsd(s.options.budgetUsd)} used up (${formatUsd(s.costUsd)} spent)`);
        continue;
      }
      try {
        const progressed = await this.step(s);
        if (!progressed) return this.d.store.state(runId);
      } catch (e) {
        const message = (e as Error).message;
        this.ev(runId, SYSTEM, { type: 'run.error', message });
        this.log(`! ${message}`);
        return this.d.store.state(runId);
      }
    }
  }

  /** Returns false when the run is parked and needs a person. */
  private async step(s: RunState): Promise<boolean> {
    switch (s.phase) {
      case 'created':
        return this.stepCreated(s);
      case 'planning':
        return this.stepPlanning(s);
      case 'awaiting_answers':
        return this.collectAnswers(s);
      case 'awaiting_plan_approval':
        return this.planGate(s);
      case 'building':
        return this.stepBuild(s);
      case 'qa':
        return this.stepQa(s);
      case 'review':
        return this.stepReview(s);
      case 'awaiting_escalation':
        return this.escalationGate(s);
      case 'finalizing':
        return this.finalize(s);
      default:
        return false;
    }
  }

  private def(name: StepName): AgentDef {
    const a = this.d.agents.get(name);
    if (!a) throw new Error(`No agent named "${name}" is defined`);
    return a;
  }

  /* ---------- Steps ---------- */

  private async stepCreated(s: RunState): Promise<boolean> {
    const profile = detectProfile(s.worktree, this.d.repoConfig.commands);
    this.ev(s.id, SYSTEM, { type: 'profile.detected', profile });
    let setup: CommandResult | null = null;
    let result: CommandResult | null = null;
    if (!s.options.skipBaseline) {
      if (profile.commands.setup) {
        this.log(`> setup: ${profile.commands.setup}`);
        setup = await runCommand(profile.commands.setup, s.worktree);
        if (setup.exitCode !== 0) this.log('! setup failed; the baseline may be red for that reason');
      }
      if (profile.commands.test) {
        this.log(`> baseline: ${profile.commands.test}`);
        result = await runCommand(profile.commands.test, s.worktree);
        this.log(`  baseline ${result.exitCode === 0 ? 'passed' : `failed (exit ${result.exitCode})`}`);
      } else {
        this.log('  no test command detected; set one in .agentpool/config.json to get a baseline');
      }
      // Setup and baseline can touch tracked files (lockfiles, snapshots). Start the agents from a clean tree.
      await git(s.worktree, ['reset', '--hard', 'HEAD']);
      await git(s.worktree, ['clean', '-fd']);
    }
    this.ev(s.id, SYSTEM, { type: 'baseline.completed', setup, result });
    this.setPhase(s.id, 'planning');
    return true;
  }

  private async stepPlanning(s: RunState): Promise<boolean> {
    const round = s.planRound + 1;
    const { value: plan } = await this.runAgent(s, 'planner', round, plannerPrompt(s), PlanSchema);
    this.ev(s.id, agent('planner'), { type: 'plan.proposed', plan, round });

    let next = s.questions.length;
    let blocking = 0;
    for (const q of plan.questions) {
      const id = `Q-${++next}`;
      const isBlocking = q.blocking && round < MAX_PLAN_ROUNDS;
      this.ev(s.id, agent('planner'), {
        type: 'question.raised',
        id,
        text: q.text,
        options: q.options,
        recommended: q.recommended,
        blocking: isBlocking,
        raisedBy: 'planner',
      });
      this.post(s.id, { type: 'question', from: 'planner', to: 'human', thread: id, round, body: q.text });
      if (isBlocking) blocking++;
    }
    this.setPhase(s.id, blocking > 0 ? 'awaiting_answers' : 'awaiting_plan_approval');
    return true;
  }

  private async collectAnswers(s: RunState): Promise<boolean> {
    const open = s.questions.filter((q) => q.blocking && q.answer === undefined);
    for (const q of open) {
      if (s.options.assumeDefaults) {
        const answer = q.recommended ?? q.options?.[0] ?? 'Use your best judgement';
        this.log(`  ${q.id}: taking the default "${answer}"`);
        this.recordAnswer(this.d.store.state(s.id), q.id, answer, true);
      } else if (this.d.channel.interactive) {
        const answer = await this.d.channel.ask(q);
        this.recordAnswer(this.d.store.state(s.id), q.id, answer, false);
      } else {
        this.log(`  parked: waiting for an answer to ${q.id}`);
        return false;
      }
    }
    this.setPhase(s.id, 'planning');
    return true;
  }

  private async planGate(s: RunState): Promise<boolean> {
    let approved = s.planApproved;
    if (approved === undefined) {
      if (s.options.autonomy === 'auto') {
        approved = true;
        this.ev(s.id, SYSTEM, { type: 'gate.decided', gate: 'plan', approved, note: 'autonomy is auto' });
      } else if (this.d.channel.interactive) {
        const r = await this.d.channel.confirmPlan(s);
        approved = r.approved;
        this.ev(s.id, human(), { type: 'gate.decided', gate: 'plan', approved, note: r.note });
      } else {
        this.log('  parked: waiting for plan approval');
        return false;
      }
    }
    if (!approved) {
      this.finish(s.id, 'rejected', 'The plan was rejected');
      return true;
    }
    this.post(s.id, {
      type: 'handoff',
      from: 'planner',
      to: 'developer',
      thread: 'plan',
      round: s.planRound,
      body: s.plan?.summary ?? 'See the approved plan.',
    });
    this.setPhase(s.id, 'building');
    return true;
  }

  private async stepBuild(s: RunState): Promise<boolean> {
    const round = s.dev.length + 1;
    const def = this.def('developer');
    const { value: dev } = await this.runAgent(s, 'developer', round, developerPrompt(s, round), DevResultSchema);
    const commit = await this.commitStep(s, 'developer', def, `agentpool(developer): round ${round}: ${truncate(firstLine(dev.summary), 60)}`);
    this.ev(s.id, agent('developer'), { type: 'dev.result', round, result: dev, commit });
    this.post(s.id, { type: 'handoff', from: 'developer', to: 'qa', thread: `build-${round}`, round, body: dev.summary });
    this.setPhase(s.id, 'qa');
    return true;
  }

  private async stepQa(s: RunState): Promise<boolean> {
    const round = s.qa.length + 1;
    const def = this.def('qa');
    const { value: qa } = await this.runAgent(s, 'qa', round, qaPrompt(s, round), QaResultSchema);
    const commit = await this.commitStep(s, 'qa', def, `agentpool(qa): round ${round}: ${qa.verdict}`);

    // Do not trust the agent's word. Run the project's own tests and record what happened.
    const testCmd = s.profile?.commands.test;
    let verified: CommandResult | null = null;
    if (testCmd) {
      this.log(`> verifying: ${testCmd}`);
      verified = await runCommand(testCmd, s.worktree);
    }
    const baselineGreen = !s.baseline?.result || s.baseline.result.exitCode === 0;
    const testsFailed = verified !== null && baselineGreen && verified.exitCode !== 0;
    const failedChecks = qa.checks.filter((c) => c.status === 'fail');

    const issues = [...qa.issues];
    if (qa.verdict === 'pass' && testsFailed && verified) {
      issues.push({ description: `The run re-ran \`${verified.command}\` after QA and it failed (exit ${verified.exitCode}) although QA reported pass.` });
    }
    if (qa.verdict === 'pass' && failedChecks.length > 0) {
      issues.push({ description: `QA reported pass but marked these checks failed: ${failedChecks.map((c) => c.criterion).join('; ')}` });
    }
    const effective: QaResult = {
      ...qa,
      verdict: qa.verdict === 'fail' || testsFailed || failedChecks.length > 0 ? 'fail' : 'pass',
      issues,
    };
    this.ev(s.id, agent('qa'), { type: 'qa.result', round, result: effective, agentVerdict: qa.verdict, verified, commit });

    if (effective.verdict === 'pass') {
      this.setPhase(s.id, 'review');
    } else if (s.dev.length < s.options.maxRounds) {
      this.post(s.id, {
        type: 'objection',
        from: 'qa',
        to: 'developer',
        thread: `qa-${round}`,
        round: s.dev.length,
        body: effective.issues.map((i) => `${i.description}${i.file ? ` (${i.file})` : ''}`).join('; ') || 'QA reported a failure without details',
      });
      this.setPhase(s.id, 'building');
    } else {
      this.setPhase(s.id, 'awaiting_escalation');
    }
    return true;
  }

  private async stepReview(s: RunState): Promise<boolean> {
    const round = s.review.length + 1;
    const def = this.def('reviewer');
    const { value } = await this.runAgent(s, 'reviewer', round, reviewerPrompt(s), ReviewResultSchema);
    // The reviewer is read-only: anything it changed is reverted by the scope check.
    await this.commitStep(s, 'reviewer', def, `agentpool(reviewer): round ${round}`);

    // The verdict follows the findings, not the other way round.
    const blocking = value.findings.filter((f) => f.severity === 'blocker' || f.severity === 'major');
    const result = { ...value, verdict: blocking.length > 0 ? ('changes_requested' as const) : ('approve' as const) };
    this.ev(s.id, agent('reviewer'), { type: 'review.result', round, result });

    if (result.verdict === 'approve') {
      this.setPhase(s.id, 'finalizing');
    } else if (s.dev.length < s.options.maxRounds) {
      this.post(s.id, {
        type: 'objection',
        from: 'reviewer',
        to: 'developer',
        thread: `review-${round}`,
        round: s.dev.length,
        body: blocking.map((f) => `${f.severity}: ${f.description}${f.file ? ` (${f.file})` : ''}`).join('; '),
      });
      this.setPhase(s.id, 'building');
    } else {
      this.setPhase(s.id, 'awaiting_escalation');
    }
    return true;
  }

  private async escalationGate(s: RunState): Promise<boolean> {
    let approved = s.escalationApproved;
    if (approved === undefined) {
      const open = [
        ...(s.qa.at(-1)?.result.verdict === 'fail' ? ['QA still reports open issues'] : []),
        ...(s.review.at(-1)?.result.verdict === 'changes_requested' ? ['the reviewer still requests changes'] : []),
      ];
      const summary = `After ${s.dev.length} round(s) ${open.join(' and ') || 'the agents are stuck'}.`;
      if (s.options.assumeDefaults) {
        approved = true;
        this.ev(s.id, SYSTEM, { type: 'gate.decided', gate: 'escalation', approved, note: 'finish anyway, flagged as not ready' });
      } else if (this.d.channel.interactive) {
        approved = await this.d.channel.confirmEscalation(s, summary);
        this.ev(s.id, human(), { type: 'gate.decided', gate: 'escalation', approved });
      } else {
        this.log(`  parked: ${summary}`);
        return false;
      }
    }
    if (approved) this.setPhase(s.id, 'finalizing');
    else this.finish(s.id, 'rejected', 'Stopped by a person after the agents could not clear every issue');
    return true;
  }

  private async finalize(s: RunState): Promise<boolean> {
    await commitAll(s.worktree, `agentpool: leftover changes\n\nAgentpool-Run: ${s.id}`);
    const [stat, commits] = await Promise.all([diffStat(s.worktree, s.baseCommit), commitLog(s.worktree, s.baseCommit)]);
    const md = buildMrDescription(s, { diffStat: stat, commits });
    const file = this.d.store.writeFile(s.id, 'MR.md', md);
    this.finish(s.id, 'done', undefined, file);
    return true;
  }

  /* ---------- Helpers ---------- */

  /** Stage the step's changes, revert anything outside the agent's write scope, and commit the rest. */
  private async commitStep(s: RunState, step: StepName, def: AgentDef, message: string): Promise<string | null> {
    const staged = await stagedPaths(s.worktree);
    const bad = staged.filter((p) => !pathAllowed(p, def.writeScope));
    if (bad.length > 0) {
      await discardPaths(s.worktree, bad);
      this.ev(s.id, agent(step), { type: 'scope.violation', step, paths: bad });
      this.log(`! ${step} changed files outside its write scope; reverted: ${bad.join(', ')}`);
    }
    return commitAll(s.worktree, `${message}\n\nAgentpool-Run: ${s.id}\nAgentpool-Agent: ${step}`);
  }

  private async runAgent<T>(
    s: RunState,
    step: StepName,
    round: number,
    prompt: string,
    schema: z.ZodType<T, unknown>,
  ): Promise<{ value: T; text: string }> {
    const def = this.def(step);
    this.ev(s.id, agent(step), { type: 'step.started', step, round });
    this.log(`> ${step} (round ${round})`);

    const remaining = s.options.budgetUsd - s.costUsd;
    const req: AgentRequest = {
      role: step,
      systemPrompt: def.systemPrompt,
      prompt,
      cwd: s.worktree,
      tools: def.tools,
      disallowedTools: def.disallowedTools,
      model: def.model ?? s.options.model,
      maxTurns: def.maxTurns,
      maxBudgetUsd: Math.max(0.05, Math.min(s.options.agentBudgetUsd, remaining)),
    };

    let costUsd = 0;
    let turns = 0;
    let durationMs = 0;
    let sessionId: string | undefined;
    const finishStep = () =>
      this.ev(s.id, agent(step), { type: 'step.finished', step, round, costUsd, turns, durationMs, sessionId });

    const out = await this.d.runner.run(req);
    costUsd += out.costUsd;
    turns += out.turns;
    durationMs += out.durationMs;
    sessionId = out.sessionId;
    if (out.isError) {
      finishStep();
      const why = out.errorKind === 'error_max_budget_usd' ? 'ran out of its budget' : out.errorKind === 'error_max_turns' ? 'ran out of turns' : `failed (${out.errorKind ?? 'unknown'})`;
      throw new Error(`The ${step} agent ${why}. Retry the step with: agentpool resume ${s.id}`);
    }

    let parsed = parseStructured(out.text, schema);
    if (!parsed.ok) {
      this.log(`  ${step} reply was not valid JSON (${parsed.error}); asking for a corrected reply`);
      const fix = await this.d.runner.run({
        ...req,
        tools: [],
        disallowedTools: [],
        maxTurns: 2,
        maxBudgetUsd: 0.5,
        prompt: repairPrompt(step, parsed.error, out.text),
      });
      costUsd += fix.costUsd;
      turns += fix.turns;
      durationMs += fix.durationMs;
      parsed = fix.isError ? parsed : parseStructured(fix.text, schema);
    }
    finishStep();
    if (!parsed.ok) {
      throw new Error(`The ${step} agent did not return usable JSON: ${parsed.error}. Retry the step with: agentpool resume ${s.id}`);
    }
    this.log(`  ${step} done in ${(durationMs / 1000).toFixed(0)}s, ${formatUsd(costUsd)}`);
    return { value: parsed.value, text: out.text };
  }
}
