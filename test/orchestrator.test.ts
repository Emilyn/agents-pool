import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatStatus } from '../src/report.js';
import {
  DEV,
  PLAN,
  QA_PASS,
  REVIEW_OK,
  ScriptedRunner,
  defaultOptions,
  fenced,
  makeOrchestrator,
  makeRepo,
} from './helpers.js';

const write = (cwd: string, name: string, content: string) => writeFileSync(join(cwd, name), content);

const happyHandlers = () => ({
  planner: () => fenced(PLAN),
  developer: (req: { cwd: string }) => {
    write(req.cwd, 'greeting.txt', 'hello\n');
    return fenced(DEV);
  },
  qa: () => fenced(QA_PASS),
  reviewer: () => fenced(REVIEW_OK),
});

describe('a full run', () => {
  it('goes from task to branch and merge request description', async () => {
    const repo = makeRepo();
    const runner = new ScriptedRunner(happyHandlers());
    const { orchestrator, store } = makeOrchestrator(repo, runner);

    const id = await orchestrator.startRun({ task: 'Add a greeting file', options: defaultOptions() });
    const s = await orchestrator.drive(id);

    expect(s.phase).toBe('done');
    expect(s.costUsd).toBeCloseTo(0.04);
    expect(existsSync(join(s.worktree, 'greeting.txt'))).toBe(true);

    // The change is on its own branch, one commit per step that changed something, and main is untouched.
    const log = execFileSync('git', ['log', '--format=%s', `main..${s.branch}`], { cwd: repo }).toString();
    expect(log).toContain('agentpool(developer): round 1: Created greeting.txt');
    expect(execFileSync('git', ['rev-parse', 'main'], { cwd: repo }).toString().trim()).toBe(s.baseCommit);
    expect(existsSync(join(repo, 'greeting.txt'))).toBe(false);

    const mr = readFileSync(s.outcome?.mrFile ?? '', 'utf8');
    expect(mr).toContain('Status: ready for human review');
    expect(mr).toContain('Created greeting.txt');
    expect(mr).toContain('agentpool log');
    expect(store.events(id).at(0)?.type).toBe('run.created');
  });

  it('keeps run files out of git status', async () => {
    const repo = makeRepo();
    const { orchestrator } = makeOrchestrator(repo, new ScriptedRunner(happyHandlers()));
    const id = await orchestrator.startRun({ task: 't', options: defaultOptions() });
    await orchestrator.drive(id);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString().trim()).toBe('');
  });
});

describe('parking on a person', () => {
  it('parks on a blocking question, resumes after the answer, then parks on plan approval', async () => {
    const repo = makeRepo();
    const handlers = happyHandlers();
    const runner = new ScriptedRunner({
      ...handlers,
      planner: (req) =>
        req.prompt.includes('# Decisions (binding)')
          ? fenced(PLAN)
          : fenced({ ...PLAN, questions: [{ text: 'Which greeting?', options: ['hello', 'hi'], recommended: 'hello', blocking: true }] }),
    });
    const { orchestrator, store } = makeOrchestrator(repo, runner);
    const id = await orchestrator.startRun({ task: 'Add a greeting', options: defaultOptions({ autonomy: 'plan-approval' }) });

    let s = await orchestrator.drive(id);
    expect(s.phase).toBe('awaiting_answers');
    expect(runner.count('developer')).toBe(0);
    expect(formatStatus(s)).toContain(`agentpool answer ${id} <question-id>`);

    orchestrator.answerQuestion(id, 'Q-1', 'hi');
    s = await orchestrator.drive(id);
    expect(s.phase).toBe('awaiting_plan_approval');
    expect(runner.count('planner')).toBe(2);
    expect(s.decisions).toMatchObject([{ id: 'D-1', answer: 'hi', viaDefault: false }]);

    orchestrator.decideGate(id, true);
    s = await orchestrator.drive(id);
    expect(s.phase).toBe('done');
    expect(runner.calls.find((c) => c.role === 'developer')?.prompt).toContain('Which greeting? -> hi');
    expect(store.events(id).filter((e) => e.type === 'gate.decided')).toHaveLength(1);
  });

  it('takes the recommended answer when told never to wait', async () => {
    const repo = makeRepo();
    const runner = new ScriptedRunner({
      ...happyHandlers(),
      planner: (req) =>
        req.prompt.includes('# Decisions (binding)')
          ? fenced(PLAN)
          : fenced({ ...PLAN, questions: [{ text: 'Which?', options: ['a', 'b'], recommended: 'b', blocking: true }] }),
    });
    const { orchestrator } = makeOrchestrator(repo, runner);
    const id = await orchestrator.startRun({ task: 't', options: defaultOptions({ assumeDefaults: true }) });
    const s = await orchestrator.drive(id);
    expect(s.phase).toBe('done');
    expect(s.decisions[0]).toMatchObject({ answer: 'b', viaDefault: true });
    expect(readFileSync(s.outcome?.mrFile ?? '', 'utf8')).toContain('default taken, nobody answered');
  });

  it('ends the run when the plan is rejected', async () => {
    const repo = makeRepo();
    const runner = new ScriptedRunner(happyHandlers());
    const { orchestrator } = makeOrchestrator(repo, runner);
    const id = await orchestrator.startRun({ task: 't', options: defaultOptions({ autonomy: 'plan-approval' }) });
    expect((await orchestrator.drive(id)).phase).toBe('awaiting_plan_approval');
    orchestrator.decideGate(id, false, 'wrong approach');
    const s = await orchestrator.drive(id);
    expect(s.phase).toBe('rejected');
    expect(runner.count('developer')).toBe(0);
  });
});

describe('feedback loops', () => {
  it('sends QA objections back to the developer, then passes', async () => {
    const repo = makeRepo();
    const runner = new ScriptedRunner({
      ...happyHandlers(),
      qa: (_req, n) =>
        n === 1
          ? fenced({ verdict: 'fail', checks: [], issues: [{ description: 'greeting has no newline', file: 'greeting.txt' }], testsAdded: [] })
          : fenced(QA_PASS),
    });
    const { orchestrator } = makeOrchestrator(repo, runner);
    const id = await orchestrator.startRun({ task: 't', options: defaultOptions() });
    const s = await orchestrator.drive(id);
    expect(s.phase).toBe('done');
    expect(s.dev).toHaveLength(2);
    expect(s.qa.map((q) => q.result.verdict)).toEqual(['fail', 'pass']);
    const second = runner.calls.filter((c) => c.role === 'developer')[1];
    expect(second?.prompt).toContain('# Feedback to fix');
    expect(second?.prompt).toContain('greeting has no newline');
    expect(s.messages.some((m) => m.type === 'objection' && m.from === 'qa' && m.to === 'developer')).toBe(true);
  });

  it('sends reviewer blockers back to the developer and ignores a verdict that contradicts the findings', async () => {
    const repo = makeRepo();
    const runner = new ScriptedRunner({
      ...happyHandlers(),
      reviewer: (_req, n) =>
        n === 1
          ? fenced({ verdict: 'approve', findings: [{ severity: 'major', description: 'swallows errors' }], unsure: [] })
          : fenced(REVIEW_OK),
    });
    const { orchestrator } = makeOrchestrator(repo, runner);
    const id = await orchestrator.startRun({ task: 't', options: defaultOptions() });
    const s = await orchestrator.drive(id);
    expect(s.review.map((r) => r.result.verdict)).toEqual(['changes_requested', 'approve']);
    expect(s.dev).toHaveLength(2);
  });

  it('parks when the round limit is hit, then finishes flagged as not ready once a person agrees', async () => {
    const repo = makeRepo();
    const runner = new ScriptedRunner({
      ...happyHandlers(),
      qa: () => fenced({ verdict: 'fail', checks: [], issues: [{ description: 'still broken' }], testsAdded: [] }),
    });
    const { orchestrator } = makeOrchestrator(repo, runner);
    const id = await orchestrator.startRun({ task: 't', options: defaultOptions({ maxRounds: 2 }) });
    let s = await orchestrator.drive(id);
    expect(s.phase).toBe('awaiting_escalation');
    expect(s.dev).toHaveLength(2);
    expect(runner.count('reviewer')).toBe(0);

    orchestrator.decideGate(id, true);
    s = await orchestrator.drive(id);
    expect(s.phase).toBe('done');
    const mr = readFileSync(s.outcome?.mrFile ?? '', 'utf8');
    expect(mr).toContain('NOT ready');
    expect(mr).toContain('still broken');
  });
});

describe('trust but verify', () => {
  it('overrules QA when the project tests fail after QA said pass', async () => {
    const repo = makeRepo({
      'check.js': "process.exit(require('fs').existsSync('BROKEN') ? 1 : 0);\n",
      '.agentpool/config.json': JSON.stringify({ commands: { test: 'node check.js' } }),
    });
    const runner = new ScriptedRunner({
      ...happyHandlers(),
      developer: (req) => {
        write(req.cwd, 'BROKEN', 'x');
        return fenced(DEV);
      },
    });
    const { orchestrator } = makeOrchestrator(repo, runner);
    const id = await orchestrator.startRun({ task: 't', options: defaultOptions({ maxRounds: 1, skipBaseline: false }) });
    const s = await orchestrator.drive(id);

    expect(s.baseline?.result?.exitCode).toBe(0);
    expect(s.qa[0]?.agentVerdict).toBe('pass');
    expect(s.qa[0]?.result.verdict).toBe('fail');
    expect(s.qa[0]?.result.issues[0]?.description).toContain('after QA and it failed');
    expect(s.phase).toBe('awaiting_escalation');
  });

  it('does not gate on tests that were already failing before the change', async () => {
    const repo = makeRepo({
      'check.js': 'process.exit(1);\n',
      '.agentpool/config.json': JSON.stringify({ commands: { test: 'node check.js' } }),
    });
    const { orchestrator } = makeOrchestrator(repo, new ScriptedRunner(happyHandlers()));
    const id = await orchestrator.startRun({ task: 't', options: defaultOptions({ skipBaseline: false }) });
    const s = await orchestrator.drive(id);
    expect(s.baseline?.result?.exitCode).toBe(1);
    expect(s.phase).toBe('done');
    expect(readFileSync(s.outcome?.mrFile ?? '', 'utf8')).toContain('they also failed before the change');
  });
});

describe('write scope', () => {
  it('reverts files QA and the reviewer should not have touched', async () => {
    const repo = makeRepo({ 'src/app.js': 'module.exports = 1;\n' });
    const runner = new ScriptedRunner({
      ...happyHandlers(),
      qa: (req) => {
        write(req.cwd, 'src/app.js', 'module.exports = 2; // QA sneaked this in\n');
        write(req.cwd, 'app.test.js', 'test\n');
        return fenced(QA_PASS);
      },
      reviewer: (req) => {
        write(req.cwd, 'reviewer-note.txt', 'hi');
        return fenced(REVIEW_OK);
      },
    });
    const { orchestrator } = makeOrchestrator(repo, runner);
    const id = await orchestrator.startRun({ task: 't', options: defaultOptions() });
    const s = await orchestrator.drive(id);

    expect(s.phase).toBe('done');
    expect(readFileSync(join(s.worktree, 'src/app.js'), 'utf8')).toBe('module.exports = 1;\n');
    expect(existsSync(join(s.worktree, 'app.test.js'))).toBe(true);
    expect(existsSync(join(s.worktree, 'reviewer-note.txt'))).toBe(false);
    expect(s.scopeViolations).toEqual([
      { step: 'qa', paths: ['src/app.js'] },
      { step: 'reviewer', paths: ['reviewer-note.txt'] },
    ]);
    expect(readFileSync(s.outcome?.mrFile ?? '', 'utf8')).toContain('outside its write scope');
  });
});

describe('failure handling', () => {
  it('repairs a reply that is not valid JSON once', async () => {
    const repo = makeRepo();
    const runner = new ScriptedRunner({
      ...happyHandlers(),
      planner: (_req, n) => (n === 1 ? 'I made a plan but forgot the JSON.' : fenced(PLAN)),
    });
    const { orchestrator } = makeOrchestrator(repo, runner);
    const id = await orchestrator.startRun({ task: 't', options: defaultOptions() });
    const s = await orchestrator.drive(id);
    expect(s.phase).toBe('done');
    expect(runner.calls.filter((c) => c.role === 'planner')[1]?.tools).toEqual([]);
  });

  it('keeps the run resumable when an agent fails', async () => {
    const repo = makeRepo();
    const runner = new ScriptedRunner({
      ...happyHandlers(),
      developer: (req, n) => {
        if (n === 1) return { error: 'error_max_turns' };
        write(req.cwd, 'greeting.txt', 'hello\n');
        return fenced(DEV);
      },
    });
    const { orchestrator } = makeOrchestrator(repo, runner);
    const id = await orchestrator.startRun({ task: 't', options: defaultOptions() });

    let s = await orchestrator.drive(id);
    expect(s.phase).toBe('building');
    expect(s.lastError).toContain('ran out of turns');
    expect(formatStatus(s)).toContain(`agentpool resume ${id}`);

    s = await orchestrator.drive(id);
    expect(s.phase).toBe('done');
    expect(s.lastError).toBeUndefined();
  });

  it('stops when the run budget is used up', async () => {
    const repo = makeRepo();
    const { orchestrator } = makeOrchestrator(repo, new ScriptedRunner(happyHandlers()));
    const id = await orchestrator.startRun({ task: 't', options: defaultOptions({ budgetUsd: 0.015 }) });
    const s = await orchestrator.drive(id);
    expect(s.phase).toBe('failed');
    expect(s.outcome?.reason).toContain('budget');
  });

  it('refuses to start in a repository with no commits', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'agentpool-empty-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    const { orchestrator } = makeOrchestrator(dir, new ScriptedRunner(happyHandlers()));
    await expect(orchestrator.startRun({ task: 't', options: defaultOptions() })).rejects.toThrow(/no commits/);
  });
});
