import { readFileSync, existsSync } from 'node:fs';
import type { RepoConfig } from './config.js';
import { createClient, detectHost, resolveToken, tokenHelp, type FetchLike, type HostClient, type HostKind } from './host.js';
import { git } from './git.js';
import { addComment, resolveJiraAuth } from './jira.js';
import { mrTitle, readiness } from './mr.js';
import type { RunStore } from './store.js';
import type { Actor } from './types.js';

export interface PublishDeps {
  repoRoot: string;
  store: RunStore;
  config: RepoConfig;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  /** Tests inject a client to skip host detection and tokens. */
  client?: HostClient;
}

export interface PublishOptions {
  remote?: string;
  /** Default: draft unless the run is ready for review. */
  draft?: boolean;
  host?: HostKind;
  dryRun?: boolean;
}

export interface PublishResult {
  url?: string;
  number?: number;
  existing: boolean;
  draft: boolean;
  dryRun: boolean;
  host: 'github' | 'gitlab';
  remote: string;
  title: string;
}

const SYSTEM: Actor = { type: 'system', id: 'publisher' };
const MAX_BODY = 60_000;

/** MR.md without the "open it yourself" shell commands, which make no sense once the platform opens it. */
export function prBody(md: string): string {
  const cut = md.indexOf('\n## Open it as a merge request');
  const body = (cut >= 0 ? md.slice(0, cut) : md).trim();
  return body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n_(description truncated)_` : body;
}

async function remoteHasBranch(repoRoot: string, remote: string, branch: string): Promise<boolean> {
  const out = await git(repoRoot, ['ls-remote', '--heads', remote, branch]);
  return out.trim().length > 0;
}

/** Push the run's branch and open (or find) the pull / merge request. Idempotent: a recorded PR is returned as is. */
export async function openPullRequest(deps: PublishDeps, runId: string, opts: PublishOptions = {}): Promise<PublishResult> {
  const { repoRoot, store, config } = deps;
  const s = store.state(runId);
  if (s.phase !== 'done') {
    throw new Error(`Run ${runId} is "${s.phase}". Only a finished run can be opened as a request. Continue it with: agentpool resume ${runId}`);
  }
  const title = mrTitle(s);
  const draft = opts.draft ?? !readiness(s).ready;
  const remote = opts.remote ?? config.git.remote ?? 'origin';

  if (s.pr) {
    return { url: s.pr.url, number: s.pr.number, existing: true, draft: s.pr.draft, dryRun: false, host: s.pr.host, remote: s.pr.remote, title };
  }

  let remoteUrl: string;
  try {
    remoteUrl = (await git(repoRoot, ['remote', 'get-url', remote])).trim();
  } catch {
    throw new Error(`This repository has no remote called "${remote}". Add one (git remote add ${remote} <url>) or pass --remote.`);
  }

  const ref = deps.client?.ref ?? detectHost(remoteUrl, { host: opts.host ?? config.git.host, apiUrl: config.git.apiUrl });
  let client = deps.client;
  if (!client && !opts.dryRun) {
    const found = resolveToken(ref.kind, deps.env);
    if (!found) throw new Error(`No ${ref.kind === 'github' ? 'GitHub' : 'GitLab'} token found for ${ref.hostname}. ${tokenHelp(ref.kind)} Nothing was pushed.`);
    client = createClient(ref, found.token, deps.fetchImpl);
  }

  if (opts.dryRun) {
    return { existing: false, draft, dryRun: true, host: ref.kind, remote, title };
  }

  // Fail before pushing when the target branch is not on the remote: the host would reject it afterwards anyway.
  if (!(await remoteHasBranch(repoRoot, remote, s.baseBranch))) {
    throw new Error(
      `The base branch "${s.baseBranch}" does not exist on ${remote}. Push it first, or start the run with --base <branch that exists there>.`,
    );
  }

  await git(repoRoot, ['push', '--set-upstream', remote, `${s.branch}:${s.branch}`]);

  const mrFile = s.outcome?.mrFile;
  const md = mrFile && existsSync(mrFile) ? readFileSync(mrFile, 'utf8') : `# ${title}\n\n(The run's MR.md was not found.)`;
  const result = await client!.createOrFind({ title, body: prBody(md), head: s.branch, base: s.baseBranch, draft });

  store.append(runId, SYSTEM, {
    type: 'pr.opened',
    host: ref.kind,
    url: result.url,
    number: result.number,
    draft,
    existing: result.existing,
    remote,
  });
  return { url: result.url, number: result.number, existing: result.existing, draft, dryRun: false, host: ref.kind, remote, title };
}

/** Post the PR link back on the Jira ticket. Only called when the developer asked for it. */
export async function commentOnJira(deps: PublishDeps, runId: string): Promise<boolean> {
  const s = deps.store.state(runId);
  if (!s.source || s.source.type !== 'jira') throw new Error(`Run ${runId} did not come from a Jira ticket.`);
  if (!s.pr) throw new Error(`Run ${runId} has no pull request yet, so there is nothing to link from the ticket.`);
  if (s.jiraCommented) return false;
  const origin = new URL(s.source.url).origin;
  const auth = resolveJiraAuth({ urlBase: origin }, deps.env);
  await addComment(
    s.source.key,
    `An agentpool run prepared a ${s.pr.draft ? 'draft ' : ''}${s.pr.host === 'github' ? 'pull' : 'merge'} request for review:`,
    { label: s.pr.url, url: s.pr.url },
    auth,
    deps.fetchImpl,
  );
  deps.store.append(runId, SYSTEM, { type: 'jira.commented', key: s.source.key });
  return true;
}
