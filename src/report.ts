import { readiness } from './mr.js';
import type { RunState } from './types.js';
import { formatUsd, truncate } from './util.js';

/** One screen of status for a run, plus what to do next. Used by the CLI and by tests. */
export function formatStatus(s: RunState): string {
  const lines = [
    `Run ${s.id}`,
    `  task:    ${truncate(s.task.replace(/\s+/g, ' '), 100)}`,
    `  phase:   ${s.phase}`,
    `  branch:  ${s.branch}`,
    `  rounds:  ${s.dev.length} build, ${s.qa.length} QA, ${s.review.length} review`,
    `  spend:   ${formatUsd(s.costUsd)} of ${formatUsd(s.options.budgetUsd)}`,
  ];
  if (s.lastError) lines.push(`  error:   ${s.lastError}`);
  lines.push('', ...nextSteps(s));
  return lines.join('\n');
}

export function nextSteps(s: RunState): string[] {
  const id = s.id;
  if (s.lastError && !['done', 'failed', 'rejected'].includes(s.phase)) {
    return [`The last step failed. Retry it with: agentpool resume ${id}`];
  }
  switch (s.phase) {
    case 'awaiting_answers': {
      const open = s.questions.filter((q) => q.blocking && q.answer === undefined);
      return [
        'Waiting for you. Open questions:',
        ...open.flatMap((q) => [
          `  ${q.id}: ${q.text}`,
          ...(q.options?.length ? [`      options: ${q.options.join(' | ')}${q.recommended ? `  (recommended: ${q.recommended})` : ''}`] : []),
        ]),
        `Answer with: agentpool answer ${id} <question-id> "<answer>"`,
        `Then continue: agentpool resume ${id}`,
      ];
    }
    case 'awaiting_plan_approval':
      return [
        'Waiting for plan approval.',
        ...(s.plan ? [`  ${truncate(s.plan.summary, 160)}`] : []),
        `Approve: agentpool approve ${id}   Reject: agentpool reject ${id} "<reason>"`,
        `Then continue: agentpool resume ${id}`,
      ];
    case 'awaiting_escalation':
      return [
        `The agents could not clear every issue in ${s.options.maxRounds} round(s).`,
        `Finish anyway, flagged as not ready: agentpool approve ${id}   Stop: agentpool reject ${id}`,
        `Then continue: agentpool resume ${id}`,
      ];
    case 'done': {
      const r = readiness(s);
      return [
        r.ready ? 'Done. Ready for human review.' : `Done, but NOT ready: ${r.reasons.join('; ')}.`,
        `Merge request description: ${s.outcome?.mrFile ?? '(missing)'}`,
        `Branch: ${s.branch}  (worktree: ${s.worktree})`,
        `Push it and open the request using the commands at the bottom of that file.`,
      ];
    }
    case 'failed':
    case 'rejected':
      return [`Run ${s.phase}: ${s.outcome?.reason ?? 'no reason recorded'}`];
    default:
      return [`The run is paused in phase "${s.phase}". Continue with: agentpool resume ${id}`];
  }
}
