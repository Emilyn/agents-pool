import * as readline from 'node:readline/promises';
import type { Question, RunState } from './types.js';

/**
 * How the platform talks to a person. In a terminal it prompts. Without a terminal the run parks and a
 * person answers later with `agentpool answer` or `agentpool approve`.
 */
export interface HumanChannel {
  readonly interactive: boolean;
  ask(q: Question): Promise<string>;
  confirmPlan(s: RunState): Promise<{ approved: boolean; note?: string }>;
  confirmEscalation(s: RunState, summary: string): Promise<boolean>;
}

export class NullChannel implements HumanChannel {
  readonly interactive = false;
  async ask(): Promise<string> {
    throw new Error('No interactive channel: answer with `agentpool answer`');
  }
  async confirmPlan(): Promise<{ approved: boolean }> {
    throw new Error('No interactive channel: decide with `agentpool approve` or `agentpool reject`');
  }
  async confirmEscalation(): Promise<boolean> {
    throw new Error('No interactive channel: decide with `agentpool approve` or `agentpool reject`');
  }
}

async function prompt(text: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(text)).trim();
  } finally {
    rl.close();
  }
}

export class TerminalChannel implements HumanChannel {
  readonly interactive = true;

  async ask(q: Question): Promise<string> {
    console.log(`\n${q.id}: ${q.text}`);
    if (q.options?.length) {
      q.options.forEach((o, i) => console.log(`  ${i + 1}) ${o}${o === q.recommended ? '   (recommended)' : ''}`));
    } else if (q.recommended) {
      console.log(`  recommended: ${q.recommended}`);
    }
    for (;;) {
      const raw = await prompt('Your answer (number, text, or Enter for the recommendation): ');
      if (raw === '' && q.recommended) return q.recommended;
      const n = Number(raw);
      if (q.options?.length && Number.isInteger(n) && n >= 1 && n <= q.options.length) return q.options[n - 1] as string;
      if (raw !== '') return raw;
      console.log('Please type an answer.');
    }
  }

  async confirmPlan(s: RunState): Promise<{ approved: boolean; note?: string }> {
    const p = s.plan;
    console.log('\nPlan for approval');
    if (p) {
      console.log(`\n${p.summary}\n\nSteps:`);
      p.steps.forEach((x, i) => console.log(`  ${i + 1}. ${x}`));
      console.log('\nAcceptance criteria:');
      p.acceptanceCriteria.forEach((x) => console.log(`  - ${x}`));
      if (p.assumptions.length) {
        console.log('\nAssumptions:');
        p.assumptions.forEach((x) => console.log(`  - ${x}`));
      }
      if (p.risks.length) {
        console.log('\nRisks:');
        p.risks.forEach((x) => console.log(`  - ${x}`));
      }
    }
    const raw = (await prompt('\nApprove this plan? [Y/n] ')).toLowerCase();
    if (raw === '' || raw === 'y' || raw === 'yes') return { approved: true };
    const note = await prompt('Reason (optional): ');
    return { approved: false, note: note || undefined };
  }

  async confirmEscalation(_s: RunState, summary: string): Promise<boolean> {
    console.log(`\n${summary}`);
    const raw = (await prompt('Finish anyway and mark the merge request as NOT ready? [y/N] ')).toLowerCase();
    return raw === 'y' || raw === 'yes';
  }
}
