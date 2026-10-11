import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoConfig } from './config.js';
import type { RepoProfile } from './types.js';

const NPM_PLACEHOLDER_TEST = /no test specified/i;

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function has(root: string, ...names: string[]): boolean {
  return names.some((n) => existsSync(join(root, n)));
}

/**
 * Cheap, deterministic repo scan: what language, what commands, what conventions. It only reads files.
 * Commands found here are tried for real by the baseline run, and `.agentpool/config.json` can override them.
 */
export function detectProfile(root: string, overrides: RepoConfig['commands'] = {}): RepoProfile {
  const languages: string[] = [];
  const commands: RepoProfile['commands'] = {};
  let packageManager: string | undefined;

  const pkg = existsSync(join(root, 'package.json')) ? readJson(join(root, 'package.json')) : null;
  if (pkg) {
    const deps = { ...(pkg.dependencies as object | undefined), ...(pkg.devDependencies as object | undefined) };
    languages.push(has(root, 'tsconfig.json') || 'typescript' in deps ? 'typescript' : 'javascript');
    packageManager = has(root, 'pnpm-lock.yaml')
      ? 'pnpm'
      : has(root, 'yarn.lock')
        ? 'yarn'
        : has(root, 'bun.lockb', 'bun.lock')
          ? 'bun'
          : 'npm';
    const hasLock = has(root, 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock');
    commands.setup =
      packageManager === 'npm'
        ? hasLock
          ? 'npm ci'
          : 'npm install'
        : packageManager === 'pnpm'
          ? 'pnpm install --frozen-lockfile'
          : packageManager === 'yarn'
            ? 'yarn install --frozen-lockfile'
            : 'bun install';
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const run = (name: string) => (packageManager === 'npm' ? `npm run ${name}` : `${packageManager} run ${name}`);
    if (scripts.test && !NPM_PLACEHOLDER_TEST.test(scripts.test)) {
      commands.test = packageManager === 'npm' ? 'npm test' : `${packageManager} test`;
    }
    if (scripts.lint) commands.lint = run('lint');
    if (scripts.build) commands.build = run('build');
  }

  if (has(root, 'pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile')) {
    languages.push('python');
    if (!commands.test && has(root, 'pytest.ini', 'tox.ini', 'conftest.py', 'tests', 'test')) {
      commands.test = 'python -m pytest -q';
    }
    if (!commands.lint && has(root, 'ruff.toml', '.ruff.toml')) commands.lint = 'ruff check .';
  }
  if (has(root, 'go.mod')) {
    languages.push('go');
    commands.test ??= 'go test ./...';
    commands.build ??= 'go build ./...';
  }
  if (has(root, 'Cargo.toml')) {
    languages.push('rust');
    commands.test ??= 'cargo test';
    commands.build ??= 'cargo build';
  }
  if (has(root, 'pom.xml')) {
    languages.push('java');
    commands.test ??= 'mvn -q test';
  } else if (has(root, 'build.gradle', 'build.gradle.kts')) {
    languages.push('java');
    commands.test ??= has(root, 'gradlew') ? './gradlew test' : 'gradle test';
  }
  if (!commands.test && has(root, 'Makefile')) {
    try {
      if (/^test:/m.test(readFileSync(join(root, 'Makefile'), 'utf8'))) commands.test = 'make test';
    } catch {
      /* unreadable Makefile: leave test undefined */
    }
  }

  // Explicit config always wins. An empty string switches a detected command off.
  for (const key of ['setup', 'test', 'lint', 'build'] as const) {
    const v = overrides[key];
    if (v !== undefined) {
      if (v === '') delete commands[key];
      else commands[key] = v;
    }
  }

  const ci: string[] = [];
  if (existsSync(join(root, '.github', 'workflows'))) ci.push('github-actions');
  if (has(root, '.gitlab-ci.yml')) ci.push('gitlab-ci');
  if (has(root, 'Jenkinsfile')) ci.push('jenkins');
  if (has(root, '.circleci')) ci.push('circleci');

  const conventionFiles = [
    'CONTRIBUTING.md',
    'CLAUDE.md',
    'AGENTS.md',
    '.editorconfig',
    '.github/CODEOWNERS',
    'CODEOWNERS',
    'docs/adr',
    'docs/decisions',
    'adr',
  ].filter((f) => existsSync(join(root, f)));

  return {
    languages: [...new Set(languages)],
    packageManager,
    commands,
    ci,
    conventionFiles,
  };
}
