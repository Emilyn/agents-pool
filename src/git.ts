import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await pexec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message: string };
    throw new Error(`git ${args.join(' ')} failed: ${err.stderr?.toString().trim() || err.message}`);
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await git(dir, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

export async function repoRoot(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
}

export async function hasCommits(dir: string): Promise<boolean> {
  try {
    await git(dir, ['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

export async function currentBranch(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

export async function resolveCommit(dir: string, ref: string): Promise<string> {
  return (await git(dir, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
}

export async function isDirty(dir: string): Promise<boolean> {
  return (await git(dir, ['status', '--porcelain'])).trim().length > 0;
}

/** Keep run logs and worktrees out of `git status` without touching the tracked .gitignore. */
export async function ensureExcluded(repo: string, lines: string[]): Promise<void> {
  const rel = (await git(repo, ['rev-parse', '--git-path', 'info/exclude'])).trim();
  const file = resolve(repo, rel);
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const missing = lines.filter((l) => !existing.split('\n').includes(l));
  if (missing.length > 0) {
    appendFileSync(file, `${existing && !existing.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  }
}

export async function addWorktree(repo: string, path: string, branch: string, base: string): Promise<void> {
  await git(repo, ['worktree', 'add', '-b', branch, path, base]);
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', path]);
}

/** Stage everything and return the changed paths. Renames are reported as a delete plus an add. */
export async function stagedPaths(worktree: string): Promise<string[]> {
  await git(worktree, ['add', '-A']);
  const out = await git(worktree, ['diff', '--cached', '--name-only', '--no-renames', '-z']);
  return out.split('\0').filter(Boolean);
}

/** Undo the given paths completely: unstage, then restore tracked files or delete new ones. */
export async function discardPaths(worktree: string, paths: string[]): Promise<void> {
  for (const p of paths) {
    await git(worktree, ['reset', '-q', 'HEAD', '--', p]);
    let tracked = true;
    try {
      await git(worktree, ['ls-files', '--error-unmatch', '--', p]);
    } catch {
      tracked = false;
    }
    if (tracked) await git(worktree, ['checkout', '--', p]);
    else rmSync(join(worktree, p), { recursive: true, force: true });
  }
}

export async function commitAll(worktree: string, message: string): Promise<string | null> {
  await git(worktree, ['add', '-A']);
  const staged = (await git(worktree, ['diff', '--cached', '--name-only'])).trim();
  if (!staged) return null;
  const email = (await git(worktree, ['config', 'user.email']).catch(() => '')).trim();
  const identity = email ? [] : ['-c', 'user.name=agentpool', '-c', 'user.email=agentpool@localhost'];
  await git(worktree, [...identity, 'commit', '--no-verify', '-q', '-m', message]);
  return (await git(worktree, ['rev-parse', '--short', 'HEAD'])).trim();
}

export async function diffStat(worktree: string, base: string): Promise<string> {
  return (await git(worktree, ['diff', '--stat', base, 'HEAD'])).trim();
}

export async function commitLog(worktree: string, base: string): Promise<string[]> {
  const out = await git(worktree, ['log', '--format=%h %s', `${base}..HEAD`]);
  return out.split('\n').filter(Boolean);
}
