import type { RunState } from './types.js';
import { firstLine, formatUsd, truncate } from './util.js';

export interface Readiness {
  ready: boolean;
  reasons: string[];
}

/** Whether the branch can go to a human as-is. Computed from recorded evidence, never from agent claims alone. */
export function readiness(s: RunState): Readiness {
  const reasons: string[] = [];
  const qa = s.qa.at(-1);
  const review = s.review.at(-1);
  if (!qa) reasons.push('QA never ran');
  else if (qa.result.verdict === 'fail') reasons.push('QA still reports open issues');
  if (qa?.verified && qa.verified.exitCode !== 0) {
    const baselineRed = s.baseline?.result && s.baseline.result.exitCode !== 0;
    reasons.push(baselineRed ? 'tests fail (they also failed before the change)' : 'tests fail after the change');
  }
  if (!review) reasons.push('review never ran');
  else if (review.result.verdict === 'changes_requested') reasons.push('the reviewer requested changes');
  return { ready: reasons.length === 0, reasons };
}

/** Title for the pull/merge request: the ticket key and summary for Jira runs, else the first line of the task. */
export function mrTitle(s: RunState): string {
  return s.source ? truncate(`${s.source.key}: ${s.source.summary}`, 100) : truncate(firstLine(s.task), 72);
}

function cmdLine(r: { command: string; exitCode: number | null; timedOut: boolean; durationMs: number } | null | undefined): string {
  if (!r) return 'not run';
  const result = r.timedOut ? 'timed out' : r.exitCode === 0 ? 'passed' : `failed (exit ${r.exitCode})`;
  return `\`${r.command}\` ${result} in ${(r.durationMs / 1000).toFixed(1)}s`;
}

const bullets = (items: string[], empty = 'None.'): string =>
  items.length === 0 ? empty : items.map((i) => `- ${i}`).join('\n');

export function buildMrDescription(s: RunState, extras: { diffStat: string; commits: string[] }): string {
  const { ready, reasons } = readiness(s);
  const dev = s.dev.at(-1)?.result;
  const qa = s.qa.at(-1);
  const review = s.review.at(-1);
  const title = mrTitle(s);

  const unsure = [
    ...(dev?.unsure ?? []),
    ...(review?.result.unsure ?? []),
    ...(s.plan?.risks.map((r) => `Risk noted by the planner: ${r}`) ?? []),
    ...(qa?.result.checks.filter((c) => c.status === 'unverified').map((c) => `QA could not verify: ${c.criterion}`) ?? []),
    ...s.questions.filter((q) => q.answer === undefined).map((q) => `Open question, nobody answered: ${q.text}`),
    ...s.scopeViolations.map((v) => `The ${v.step} agent changed files outside its write scope; those changes were reverted: ${v.paths.join(', ')}`),
    ...(qa && qa.agentVerdict === 'pass' && qa.result.verdict === 'fail' ? ['QA reported pass but the recorded evidence disagreed, so the run treated it as a fail.'] : []),
  ];

  const assumptions = [
    ...(s.plan?.assumptions ?? []),
    ...s.dev.flatMap((d) => d.result.assumptions),
  ];

  const decisions = s.decisions.map(
    (d) => `- **${d.id}** ${d.question} -> **${d.answer}**${d.viaDefault ? ' (default taken, nobody answered)' : ' (answered by a human)'}`,
  );

  const testRows = [
    `| Before the change | ${cmdLine(s.baseline?.result)} |`,
    ...s.qa.map((q) => `| After QA, round ${q.round} | ${cmdLine(q.verified)} |`),
  ];

  const checks = qa?.result.checks ?? [];

  return [
    `# ${title}`,
    '',
    ready
      ? `**Status: ready for human review.**${s.qa.some((q) => q.verified) ? '' : ' No project tests were run by the platform, so this rests on the agents\' own checks.'}`
      : `**Status: NOT ready.** ${reasons.join('; ')}.`,
    '',
    `Produced by agentpool run \`${s.id}\` on branch \`${s.branch}\` (base \`${s.baseBranch}\` at \`${s.baseCommit.slice(0, 8)}\`).`,
    '',
    ...(s.source ? [`Ticket: ${s.source.url}`, ''] : []),
    '## Task',
    s.task.trim(),
    '',
    '## Summary',
    dev?.summary ?? 'No developer summary was recorded.',
    '',
    '## Plan',
    s.plan?.summary ?? 'No plan was recorded.',
    '',
    bullets(s.plan?.steps ?? []),
    '',
    '## Decisions and assumptions',
    decisions.length > 0 ? decisions.join('\n') : 'No human decisions were needed.',
    '',
    'Assumptions the agents made without asking:',
    bullets(assumptions),
    '',
    '## Test evidence',
    'The run itself executed these commands. They are not agent claims.',
    '',
    '| When | Result |',
    '| --- | --- |',
    ...testRows,
    '',
    '## QA',
    qa ? `Verdict: **${qa.result.verdict}** after ${s.qa.length} round(s).` : 'QA did not run.',
    '',
    checks.length > 0
      ? ['| Criterion | Status | Evidence |', '| --- | --- | --- |', ...checks.map((c) => `| ${c.criterion} | ${c.status} | ${truncate(c.evidence.replace(/\|/g, '/'), 120)} |`)].join('\n')
      : '',
    '',
    qa && qa.result.issues.length > 0 ? `Open issues:\n${bullets(qa.result.issues.map((i) => `${i.description}${i.file ? ` (${i.file})` : ''}`))}` : '',
    qa && qa.result.testsAdded.length > 0 ? `Tests added by QA:\n${bullets(qa.result.testsAdded)}` : '',
    '',
    '## Review',
    review ? `Verdict: **${review.result.verdict}**.` : 'The reviewer did not run.',
    '',
    review && review.result.findings.length > 0
      ? bullets(review.result.findings.map((f) => `**${f.severity}** ${f.description}${f.file ? ` (${f.file})` : ''}`))
      : review
        ? 'No findings.'
        : '',
    '',
    '## What the agents were unsure about',
    bullets(unsure, 'Nothing was flagged.'),
    '',
    '## Changes',
    '```',
    extras.diffStat || 'No changes.',
    '```',
    '',
    bullets(extras.commits, 'No commits.'),
    '',
    '## Run',
    `Rounds: ${s.dev.length} build, ${s.qa.length} QA, ${s.review.length} review. Model spend: ${formatUsd(s.costUsd)}. Inspect the full history with \`agentpool log ${s.id}\`.`,
    '',
    '## Open it as a merge request',
    '```sh',
    `git push -u origin ${s.branch}`,
    '# GitHub',
    `gh pr create --base ${s.baseBranch} --head ${s.branch} --title "${title.replace(/"/g, '\\"')}" --body-file .agentpool/runs/${s.id}/MR.md`,
    '# GitLab',
    `glab mr create --source-branch ${s.branch} --target-branch ${s.baseBranch} --title "${title.replace(/"/g, '\\"')}" --description "$(cat .agentpool/runs/${s.id}/MR.md)"`,
    '```',
    '',
  ]
    .filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
    .join('\n');
}
