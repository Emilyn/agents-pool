import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** Root of this package: holds the built-in `agents/` and `skills/` folders (works from src/ and dist/). */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

const FrontmatterSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  tools: z.array(z.string()).default([]),
  disallowedTools: z.array(z.string()).default([]),
  writeScope: z.array(z.string()).default([]),
  maxTurns: z.number().int().positive().default(30),
  model: z.string().optional(),
  skills: z.array(z.string()).default([]),
});

export interface AgentDef {
  name: string;
  role: string;
  tools: string[];
  disallowedTools: string[];
  writeScope: string[];
  maxTurns: number;
  model?: string;
  skills: string[];
  systemPrompt: string;
  source: 'builtin' | 'repo';
}

export const RepoConfigSchema = z.object({
  commands: z
    .object({
      setup: z.string().optional(),
      test: z.string().optional(),
      lint: z.string().optional(),
      build: z.string().optional(),
    })
    .default({}),
  autonomy: z.enum(['plan-approval', 'auto']).optional(),
  maxRounds: z.number().int().positive().optional(),
  budgetUsd: z.number().positive().optional(),
  agentBudgetUsd: z.number().positive().optional(),
  model: z.string().optional(),
  git: z
    .object({
      host: z.enum(['github', 'gitlab']).optional(),
      /** Full API root, e.g. https://git.example.com/api/v4 */
      apiUrl: z.string().url().optional(),
      remote: z.string().optional(),
    })
    .default({}),
  jira: z.object({ baseUrl: z.string().url().optional() }).default({}),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export function loadRepoConfig(repoRoot: string): RepoConfig {
  const file = join(repoRoot, '.agentpool', 'config.json');
  if (!existsSync(file)) return RepoConfigSchema.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Could not read ${file}: ${(e as Error).message}`);
  }
  const parsed = RepoConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid ${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

export function splitFrontmatter(source: string): { data: unknown; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!m) throw new Error('missing frontmatter block (--- ... ---)');
  return { data: parseYaml(m[1] ?? '') as unknown, body: (m[2] ?? '').trim() };
}

function readSkill(name: string, dirs: string[]): string {
  for (const dir of dirs) {
    const file = join(dir, `${name}.md`);
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  }
  throw new Error(`Skill "${name}" not found. Looked in: ${dirs.join(', ')}`);
}

/**
 * Agents are markdown files with YAML frontmatter. Built-ins ship with the package; a repo can add or
 * replace agents and skills under `.agentpool/agents` and `.agentpool/skills`. Repo files win by name.
 */
export function loadAgents(repoRoot: string): Map<string, AgentDef> {
  const agentDirs: [string, 'builtin' | 'repo'][] = [
    [join(PACKAGE_ROOT, 'agents'), 'builtin'],
    [join(repoRoot, '.agentpool', 'agents'), 'repo'],
  ];
  const skillDirs = [join(repoRoot, '.agentpool', 'skills'), join(PACKAGE_ROOT, 'skills')];
  const agents = new Map<string, AgentDef>();

  for (const [dir, source] of agentDirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
      const path = join(dir, file);
      let front: z.infer<typeof FrontmatterSchema>;
      let body: string;
      try {
        const split = splitFrontmatter(readFileSync(path, 'utf8'));
        front = FrontmatterSchema.parse(split.data);
        body = split.body;
      } catch (e) {
        throw new Error(`Invalid agent file ${path}: ${(e as Error).message}`);
      }
      const skills = front.skills.map((s) => readSkill(s, skillDirs));
      agents.set(front.name, {
        name: front.name,
        role: front.role,
        tools: front.tools,
        disallowedTools: front.disallowedTools,
        writeScope: front.writeScope,
        maxTurns: front.maxTurns,
        model: front.model,
        skills: front.skills,
        systemPrompt: [body, ...skills].join('\n\n'),
        source,
      });
    }
  }
  return agents;
}
