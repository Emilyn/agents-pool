import type { RunEvent, RunState } from './types.js';

/** Fold an event log into the current run state. The log is the only source of truth. */
export function reduce(events: RunEvent[]): RunState {
  const first = events[0];
  if (!first || first.type !== 'run.created') {
    throw new Error('A run must start with a run.created event');
  }
  const s: RunState = {
    id: first.runId,
    task: first.task,
    repo: first.repo,
    baseBranch: first.baseBranch,
    baseCommit: first.baseCommit,
    branch: first.branch,
    worktree: first.worktree,
    options: first.options,
    source: first.source,
    createdAt: first.ts,
    updatedAt: first.ts,
    phase: 'created',
    planRound: 0,
    questions: [],
    decisions: [],
    messages: [],
    dev: [],
    qa: [],
    review: [],
    scopeViolations: [],
    costUsd: 0,
  };

  for (const e of events) {
    s.updatedAt = e.ts;
    switch (e.type) {
      case 'run.created':
        break;
      case 'profile.detected':
        s.profile = e.profile;
        break;
      case 'baseline.completed':
        s.baseline = { setup: e.setup, result: e.result };
        break;
      case 'plan.proposed':
        s.plan = e.plan;
        s.planRound = e.round;
        break;
      case 'question.raised':
        s.questions.push({
          id: e.id,
          text: e.text,
          options: e.options,
          recommended: e.recommended,
          blocking: e.blocking,
          raisedBy: e.raisedBy,
        });
        break;
      case 'question.answered': {
        const q = s.questions.find((x) => x.id === e.id);
        if (q) {
          q.answer = e.answer;
          q.answeredByDefault = e.viaDefault;
          s.decisions.push({
            id: `D-${s.decisions.length + 1}`,
            questionId: q.id,
            question: q.text,
            answer: e.answer,
            viaDefault: e.viaDefault,
          });
        }
        break;
      }
      case 'gate.decided':
        if (e.gate === 'plan') s.planApproved = e.approved;
        else s.escalationApproved = e.approved;
        break;
      case 'step.started':
        s.lastError = undefined;
        break;
      case 'step.finished':
        s.costUsd += e.costUsd;
        break;
      case 'message.posted':
        s.messages.push(e.message);
        break;
      case 'dev.result':
        s.dev.push({ round: e.round, result: e.result, commit: e.commit });
        break;
      case 'qa.result':
        s.qa.push({
          round: e.round,
          result: e.result,
          agentVerdict: e.agentVerdict,
          verified: e.verified,
          commit: e.commit,
        });
        break;
      case 'review.result':
        s.review.push({ round: e.round, result: e.result });
        break;
      case 'scope.violation':
        s.scopeViolations.push({ step: e.step, paths: e.paths });
        break;
      case 'phase.changed':
        s.phase = e.phase;
        break;
      case 'run.error':
        s.lastError = e.message;
        break;
      case 'pr.opened':
        s.pr = { host: e.host, url: e.url, number: e.number, draft: e.draft, existing: e.existing, remote: e.remote };
        break;
      case 'jira.commented':
        s.jiraCommented = true;
        break;
      case 'run.finished':
        s.phase = e.outcome;
        s.outcome = { outcome: e.outcome, reason: e.reason, mrFile: e.mrFile };
        break;
    }
  }
  return s;
}
