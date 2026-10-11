import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PlanSchema } from '../src/types.js';
import { extractJsonText, parseStructured } from '../src/parse.js';
import { detectProfile } from '../src/profile.js';
import { pathAllowed } from '../src/scope.js';

describe('write scope', () => {
  const dev = ['**', '!.agentpool/**', '!.git/**'];
  const qa = ['**/*.test.*', 'test/**', 'tests/**'];

  it('lets the developer change code but not agentpool config', () => {
    expect(pathAllowed('src/app.ts', dev)).toBe(true);
    expect(pathAllowed('README.md', dev)).toBe(true);
    expect(pathAllowed('.agentpool/config.json', dev)).toBe(false);
  });

  it('limits QA to test files', () => {
    expect(pathAllowed('src/app.test.ts', qa)).toBe(true);
    expect(pathAllowed('app.test.ts', qa)).toBe(true);
    expect(pathAllowed('test/deep/x.js', qa)).toBe(true);
    expect(pathAllowed('src/app.ts', qa)).toBe(false);
    expect(pathAllowed('contest/x.js', qa)).toBe(false);
  });

  it('treats an empty scope as read-only', () => {
    expect(pathAllowed('anything', [])).toBe(false);
  });
});

describe('structured replies', () => {
  const plan = { summary: 's', steps: ['a'], acceptanceCriteria: ['b'] };

  it('takes the last fenced json block', () => {
    const text = 'x\n```json\n{"a":1}\n```\nmore\n```json\n{"b":2}\n```';
    expect(JSON.parse(extractJsonText(text) ?? '{}')).toEqual({ b: 2 });
  });

  it('ignores code blocks in other languages', () => {
    const text = '```ts\nconst x = 1;\n```\n```json\n{"ok":true}\n```';
    expect(JSON.parse(extractJsonText(text) ?? '{}')).toEqual({ ok: true });
  });

  it('applies defaults and validates the shape', () => {
    const ok = parseStructured(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``, PlanSchema);
    expect(ok.ok && ok.value.questions).toEqual([]);
    const bad = parseStructured('```json\n{"summary":"s"}\n```', PlanSchema);
    expect(bad.ok).toBe(false);
    expect(parseStructured('no json here', PlanSchema).ok).toBe(false);
  });
});

describe('repo profile', () => {
  const dir = (files: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), 'agentpool-profile-'));
    for (const [k, v] of Object.entries(files)) {
      mkdirSync(join(d, k, '..'), { recursive: true });
      writeFileSync(join(d, k), v);
    }
    return d;
  };

  it('detects a pnpm TypeScript project', () => {
    const p = detectProfile(
      dir({
        'package.json': JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .', build: 'tsc' } }),
        'pnpm-lock.yaml': '',
        'tsconfig.json': '{}',
        'CONTRIBUTING.md': '',
        '.github/workflows/ci.yml': '',
      }),
    );
    expect(p.languages).toEqual(['typescript']);
    expect(p.packageManager).toBe('pnpm');
    expect(p.commands).toEqual({ setup: 'pnpm install --frozen-lockfile', test: 'pnpm test', lint: 'pnpm run lint', build: 'pnpm run build' });
    expect(p.ci).toEqual(['github-actions']);
    expect(p.conventionFiles).toContain('CONTRIBUTING.md');
  });

  it('ignores the npm placeholder test script', () => {
    const p = detectProfile(dir({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }));
    expect(p.commands.test).toBeUndefined();
  });

  it('detects go and lets config override or switch off commands', () => {
    const d = dir({ 'go.mod': 'module x' });
    expect(detectProfile(d).commands.test).toBe('go test ./...');
    const p = detectProfile(d, { test: 'make check', build: '' });
    expect(p.commands.test).toBe('make check');
    expect(p.commands.build).toBeUndefined();
  });
});
