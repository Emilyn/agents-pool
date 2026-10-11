import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** What the orchestrator asks of an agent, independent of how the agent is executed. */
export interface AgentRequest {
  role: string;
  systemPrompt: string;
  prompt: string;
  cwd: string;
  tools: string[];
  disallowedTools: string[];
  model?: string;
  maxTurns: number;
  maxBudgetUsd: number;
}

export interface AgentOutcome {
  text: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  sessionId?: string;
  isError: boolean;
  errorKind?: string;
}

export interface AgentRunner {
  run(req: AgentRequest): Promise<AgentOutcome>;
}

/**
 * Runs one agent as a Claude Code style agent through the Claude Agent SDK. Each agent gets its own
 * tool allowlist, working directory, turn limit and budget. Needs ANTHROPIC_API_KEY (or an existing
 * Claude Code login) in the environment.
 */
export class ClaudeAgentRunner implements AgentRunner {
  async run(req: AgentRequest): Promise<AgentOutcome> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const started = Date.now();
    let final:
      | {
          subtype: string;
          is_error: boolean;
          result?: string;
          total_cost_usd: number;
          num_turns: number;
          session_id: string;
        }
      | undefined;

    const stream = query({
      prompt: req.prompt,
      options: {
        cwd: req.cwd,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: req.systemPrompt },
        tools: req.tools,
        allowedTools: req.tools,
        disallowedTools: req.disallowedTools,
        permissionMode: 'acceptEdits',
        model: req.model,
        maxTurns: req.maxTurns,
        maxBudgetUsd: req.maxBudgetUsd,
        settingSources: ['project'],
        persistSession: false,
      },
    });

    for await (const msg of stream) {
      if (msg.type === 'result') {
        final = msg as unknown as NonNullable<typeof final>;
      }
    }

    if (!final) {
      return { text: '', costUsd: 0, turns: 0, durationMs: Date.now() - started, isError: true, errorKind: 'no_result' };
    }
    const ok = final.subtype === 'success' && !final.is_error;
    return {
      text: ok ? (final.result ?? '') : '',
      costUsd: final.total_cost_usd ?? 0,
      turns: final.num_turns ?? 0,
      durationMs: Date.now() - started,
      sessionId: final.session_id,
      isError: !ok,
      errorKind: ok ? undefined : final.subtype,
    };
  }
}

/**
 * Deterministic stand-in agents for trying the whole flow without spending anything. The task text can
 * contain markers: [ask] makes the planner raise a blocking question, [qa-fail-once] makes QA reject
 * the first build, [review-block-once] makes the reviewer request changes once.
 */
export class DryRunRunner implements AgentRunner {
  async run(req: AgentRequest): Promise<AgentOutcome> {
    const base = { costUsd: 0, turns: 1, durationMs: 1, isError: false };
    const round = Number(/^Round: (\d+)/m.exec(req.prompt)?.[1] ?? '1');
    const json = (o: unknown) => `Dry run reply.\n\n\`\`\`json\n${JSON.stringify(o, null, 2)}\n\`\`\``;

    switch (req.role) {
      case 'planner': {
        const decided = req.prompt.includes('# Decisions (binding)');
        const ask = req.prompt.includes('[ask]') && !decided;
        return {
          ...base,
          text: json({
            summary: 'Dry run plan: record the task in AGENTPOOL_DRYRUN.md.',
            steps: ['Append a line for this run to AGENTPOOL_DRYRUN.md'],
            acceptanceCriteria: ['AGENTPOOL_DRYRUN.md exists and mentions the run'],
            risks: [],
            assumptions: ['This is a dry run: no real model was used'],
            questions: ask
              ? [{ text: 'Which format should the dry run file use?', options: ['bullets', 'table'], recommended: 'bullets', blocking: true }]
              : [],
          }),
        };
      }
      case 'developer': {
        const file = join(req.cwd, 'AGENTPOOL_DRYRUN.md');
        appendFileSync(file, `- dry run build, round ${round}\n`);
        return {
          ...base,
          text: json({
            summary: `Dry run build, round ${round}.`,
            filesChanged: ['AGENTPOOL_DRYRUN.md'],
            testsRun: 'none (dry run)',
            assumptions: [],
            unsure: [],
          }),
        };
      }
      case 'qa': {
        const fail = req.prompt.includes('[qa-fail-once]') && round === 1;
        const exists = existsSync(join(req.cwd, 'AGENTPOOL_DRYRUN.md')) && readFileSync(join(req.cwd, 'AGENTPOOL_DRYRUN.md'), 'utf8').length > 0;
        return {
          ...base,
          text: json({
            verdict: fail || !exists ? 'fail' : 'pass',
            checks: [{ criterion: 'AGENTPOOL_DRYRUN.md exists and mentions the run', status: exists && !fail ? 'pass' : 'fail', evidence: 'checked the file' }],
            issues: fail ? [{ description: 'Dry run QA rejects the first build on request', file: 'AGENTPOOL_DRYRUN.md' }] : [],
            testsAdded: [],
          }),
        };
      }
      case 'reviewer': {
        const block = req.prompt.includes('[review-block-once]') && round === 1;
        return {
          ...base,
          text: json({
            verdict: block ? 'changes_requested' : 'approve',
            findings: block ? [{ severity: 'major', file: 'AGENTPOOL_DRYRUN.md', description: 'Dry run reviewer requests changes once' }] : [],
            unsure: [],
          }),
        };
      }
      default:
        return { ...base, text: json({}) };
    }
  }
}

export function createRunner(kind: 'claude' | 'dry-run'): AgentRunner {
  return kind === 'dry-run' ? new DryRunRunner() : new ClaudeAgentRunner();
}
