import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reduce } from './state.js';
import type { Actor, EventBody, RunEvent, RunState } from './types.js';

/**
 * Append-only event log per run, stored as JSON lines under `<repo>/.agentpool/runs/<id>/events.jsonl`.
 * Run state is always derived by folding the log, so a run can be stopped and resumed from any machine
 * that has the log.
 */
export class RunStore {
  readonly runsDir: string;

  constructor(repoRoot: string) {
    this.runsDir = join(repoRoot, '.agentpool', 'runs');
  }

  runDir(id: string): string {
    return join(this.runsDir, id);
  }

  private logFile(id: string): string {
    return join(this.runDir(id), 'events.jsonl');
  }

  exists(id: string): boolean {
    return existsSync(this.logFile(id));
  }

  append(id: string, actor: Actor, body: EventBody): RunEvent {
    mkdirSync(this.runDir(id), { recursive: true });
    const seq = this.events(id).length + 1;
    const event = { seq, ts: new Date().toISOString(), actor, ...body } as RunEvent;
    appendFileSync(this.logFile(id), `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  }

  events(id: string): RunEvent[] {
    const file = this.logFile(id);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RunEvent);
  }

  state(id: string): RunState {
    const events = this.events(id);
    if (events.length === 0) throw new Error(`No run found with id ${id}`);
    return reduce(events);
  }

  list(): string[] {
    if (!existsSync(this.runsDir)) return [];
    return readdirSync(this.runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && this.exists(d.name))
      .map((d) => d.name)
      .sort();
  }

  latest(): string | undefined {
    return this.list().at(-1);
  }

  writeFile(id: string, name: string, content: string): string {
    mkdirSync(this.runDir(id), { recursive: true });
    const path = join(this.runDir(id), name);
    writeFileSync(path, content, 'utf8');
    return path;
  }
}
