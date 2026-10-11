import { z } from 'zod';

/* ---------- Structured results the agents must return ---------- */

export const PlanQuestionSchema = z.object({
  text: z.string().min(1),
  options: z.array(z.string()).optional(),
  recommended: z.string().optional(),
  blocking: z.boolean().default(false),
});

export const PlanSchema = z.object({
  summary: z.string().min(1),
  steps: z.array(z.string()).min(1),
  acceptanceCriteria: z.array(z.string()).min(1),
  risks: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  questions: z.array(PlanQuestionSchema).default([]),
});
export type Plan = z.infer<typeof PlanSchema>;

export const DevResultSchema = z.object({
  summary: z.string().min(1),
  filesChanged: z.array(z.string()).default([]),
  testsRun: z.string().default(''),
  assumptions: z.array(z.string()).default([]),
  unsure: z.array(z.string()).default([]),
});
export type DevResult = z.infer<typeof DevResultSchema>;

export const QaResultSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  checks: z
    .array(
      z.object({
        criterion: z.string(),
        status: z.enum(['pass', 'fail', 'unverified']),
        evidence: z.string().default(''),
      }),
    )
    .default([]),
  issues: z.array(z.object({ description: z.string(), file: z.string().optional() })).default([]),
  testsAdded: z.array(z.string()).default([]),
});
export type QaResult = z.infer<typeof QaResultSchema>;

export const ReviewResultSchema = z.object({
  verdict: z.enum(['approve', 'changes_requested']),
  findings: z
    .array(
      z.object({
        severity: z.enum(['blocker', 'major', 'minor']),
        file: z.string().optional(),
        description: z.string(),
      }),
    )
    .default([]),
  unsure: z.array(z.string()).default([]),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/* ---------- Run model ---------- */

export type Phase =
  | 'created'
  | 'planning'
  | 'awaiting_answers'
  | 'awaiting_plan_approval'
  | 'building'
  | 'qa'
  | 'review'
  | 'awaiting_escalation'
  | 'finalizing'
  | 'done'
  | 'failed'
  | 'rejected';

export const TERMINAL_PHASES: readonly Phase[] = ['done', 'failed', 'rejected'];

export type StepName = 'planner' | 'developer' | 'qa' | 'reviewer';

export type ActorType = 'human' | 'agent' | 'system';
export interface Actor {
  type: ActorType;
  id: string;
}

export type MessageType = 'question' | 'proposal' | 'objection' | 'decision' | 'handoff' | 'blocker';

export interface Message {
  id: string;
  type: MessageType;
  from: string;
  to: string;
  thread: string;
  round: number;
  body: string;
}

export interface RunOptions {
  autonomy: 'plan-approval' | 'auto';
  maxRounds: number;
  budgetUsd: number;
  agentBudgetUsd: number;
  assumeDefaults: boolean;
  runner: 'claude' | 'dry-run';
  model?: string;
  skipBaseline: boolean;
}

export interface CommandResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

export interface RepoProfile {
  languages: string[];
  packageManager?: string;
  commands: { setup?: string; test?: string; lint?: string; build?: string };
  ci: string[];
  conventionFiles: string[];
}

/* ---------- Events (append-only, the source of truth) ---------- */

export type EventBody =
  | {
      type: 'run.created';
      runId: string;
      task: string;
      repo: string;
      baseBranch: string;
      baseCommit: string;
      branch: string;
      worktree: string;
      options: RunOptions;
    }
  | { type: 'profile.detected'; profile: RepoProfile }
  | { type: 'baseline.completed'; setup: CommandResult | null; result: CommandResult | null }
  | { type: 'plan.proposed'; plan: Plan; round: number }
  | {
      type: 'question.raised';
      id: string;
      text: string;
      options?: string[];
      recommended?: string;
      blocking: boolean;
      raisedBy: string;
    }
  | { type: 'question.answered'; id: string; answer: string; viaDefault: boolean }
  | { type: 'gate.decided'; gate: 'plan' | 'escalation'; approved: boolean; note?: string }
  | { type: 'step.started'; step: StepName; round: number }
  | {
      type: 'step.finished';
      step: StepName;
      round: number;
      costUsd: number;
      turns: number;
      durationMs: number;
      sessionId?: string;
    }
  | { type: 'message.posted'; message: Message }
  | { type: 'dev.result'; round: number; result: DevResult; commit: string | null }
  | { type: 'qa.result'; round: number; result: QaResult; agentVerdict: 'pass' | 'fail'; verified: CommandResult | null; commit: string | null }
  | { type: 'review.result'; round: number; result: ReviewResult }
  | { type: 'scope.violation'; step: StepName; paths: string[] }
  | { type: 'phase.changed'; phase: Phase }
  | { type: 'run.error'; message: string }
  | { type: 'run.finished'; outcome: 'done' | 'failed' | 'rejected'; reason?: string; mrFile?: string };

export type RunEvent = { seq: number; ts: string; actor: Actor } & EventBody;

/* ---------- Derived state ---------- */

export interface Question {
  id: string;
  text: string;
  options?: string[];
  recommended?: string;
  blocking: boolean;
  raisedBy: string;
  answer?: string;
  answeredByDefault?: boolean;
}

export interface Decision {
  id: string;
  questionId: string;
  question: string;
  answer: string;
  viaDefault: boolean;
}

export interface RunState {
  id: string;
  task: string;
  repo: string;
  baseBranch: string;
  baseCommit: string;
  branch: string;
  worktree: string;
  options: RunOptions;
  createdAt: string;
  updatedAt: string;
  phase: Phase;
  profile?: RepoProfile;
  baseline?: { setup: CommandResult | null; result: CommandResult | null };
  plan?: Plan;
  planRound: number;
  planApproved?: boolean;
  escalationApproved?: boolean;
  questions: Question[];
  decisions: Decision[];
  messages: Message[];
  dev: { round: number; result: DevResult; commit: string | null }[];
  qa: { round: number; result: QaResult; agentVerdict: 'pass' | 'fail'; verified: CommandResult | null; commit: string | null }[];
  review: { round: number; result: ReviewResult }[];
  scopeViolations: { step: StepName; paths: string[] }[];
  costUsd: number;
  lastError?: string;
  outcome?: { outcome: 'done' | 'failed' | 'rejected'; reason?: string; mrFile?: string };
}
