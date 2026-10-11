import { execFileSync } from 'node:child_process';

export type HostKind = 'github' | 'gitlab';
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HostRef {
  kind: HostKind;
  hostname: string;
  webUrl: string;
  /** API root without a trailing slash. */
  apiUrl: string;
  /** `owner/repo` for GitHub, `group/subgroup/project` for GitLab. */
  project: string;
}

export interface PrRequest {
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
}

export interface PrResult {
  url: string;
  number: number;
  existing: boolean;
}

export interface HostClient {
  ref: HostRef;
  createOrFind(req: PrRequest): Promise<PrResult>;
}

/** Split a git remote URL (scp-like or URL form) into hostname and project path. */
export function parseRemoteUrl(remote: string): { hostname: string; path: string } | null {
  const url = remote.trim();
  let hostname: string | undefined;
  let path: string | undefined;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(url);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    hostname = scp[1];
    path = scp[2];
  } else {
    try {
      const u = new URL(url);
      hostname = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  if (!hostname || hostname.length < 2 || !path) return null;
  const clean = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  if (!clean.includes('/')) return null;
  return { hostname: hostname.toLowerCase(), path: clean };
}

/**
 * Work out which host a remote points at. github.com and gitlab.com are recognised by name; anything else
 * (self-hosted) needs `host` from `.agentpool/config.json` or `--host`, or a hostname that contains "gitlab".
 */
export function detectHost(remoteUrl: string, opts: { host?: HostKind; apiUrl?: string } = {}): HostRef {
  const parsed = parseRemoteUrl(remoteUrl);
  if (!parsed) throw new Error(`Could not understand the remote URL "${remoteUrl}".`);
  const { hostname, path } = parsed;
  let kind = opts.host;
  if (!kind) {
    if (hostname === 'github.com' || hostname.endsWith('.github.com')) kind = 'github';
    else if (hostname === 'gitlab.com' || hostname.includes('gitlab')) kind = 'gitlab';
    else if (hostname.includes('github')) kind = 'github';
  }
  if (!kind) {
    throw new Error(
      `Cannot tell whether ${hostname} is GitHub or GitLab. Set "git": { "host": "github" | "gitlab" } in .agentpool/config.json, or pass --host.`,
    );
  }
  const webUrl = `https://${hostname}`;
  const apiUrl = (
    opts.apiUrl ??
    (kind === 'github' ? (hostname === 'github.com' ? 'https://api.github.com' : `${webUrl}/api/v3`) : `${webUrl}/api/v4`)
  ).replace(/\/+$/, '');
  if (kind === 'github' && path.split('/').length !== 2) {
    throw new Error(`"${path}" does not look like a GitHub owner/repo path.`);
  }
  return { kind, hostname, webUrl, apiUrl, project: path };
}

/** Read the token from the environment. Returns where it came from, never printing the value. */
export function resolveToken(kind: HostKind, env: NodeJS.ProcessEnv = process.env): { token: string; source: string } | null {
  const names = kind === 'github' ? ['GITHUB_TOKEN', 'GH_TOKEN'] : ['GITLAB_TOKEN', 'GITLAB_PRIVATE_TOKEN'];
  for (const n of names) {
    const v = env[n]?.trim();
    if (v) return { token: v, source: n };
  }
  if (kind === 'github') {
    try {
      const out = execFileSync('gh', ['auth', 'token'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim();
      if (out) return { token: out, source: 'gh auth token' };
    } catch {
      /* gh missing or not logged in */
    }
  }
  return null;
}

export const tokenHelp = (kind: HostKind): string =>
  kind === 'github'
    ? 'Set GITHUB_TOKEN (a token with "repo" / pull request write access) or run `gh auth login`.'
    : 'Set GITLAB_TOKEN (a personal access token with the "api" scope).';

class HostError extends Error {}

async function readBody(res: Response): Promise<{ json: any; text: string }> {
  const text = await res.text();
  try {
    return { json: text ? JSON.parse(text) : null, text };
  } catch {
    return { json: null, text };
  }
}

function explain(res: Response, body: { json: any; text: string }, ref: HostRef, what: string): HostError {
  const detail = body.json?.message ?? body.json?.error ?? body.text.slice(0, 300);
  const extra = body.json?.errors ? ` ${JSON.stringify(body.json.errors).slice(0, 300)}` : '';
  if (res.status === 401) return new HostError(`${ref.hostname} rejected the token (401) while trying to ${what}. ${tokenHelp(ref.kind)}`);
  if (res.status === 403) return new HostError(`${ref.hostname} refused to ${what} (403): the token lacks permission. ${detail}`);
  if (res.status === 404)
    return new HostError(
      `${ref.hostname} says ${ref.project} was not found (404) while trying to ${what}. Either the project name is wrong or the token cannot see it.`,
    );
  return new HostError(`${ref.hostname} could not ${what} (${res.status}): ${detail}${extra}`);
}

export function createClient(ref: HostRef, token: string, fetchImpl: FetchLike = fetch): HostClient {
  const headers: Record<string, string> =
    ref.kind === 'github'
      ? {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'agentpool',
          'Content-Type': 'application/json',
        }
      : { 'PRIVATE-TOKEN': token, 'User-Agent': 'agentpool', 'Content-Type': 'application/json' };

  const call = (method: string, path: string, body?: unknown) =>
    fetchImpl(`${ref.apiUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

  if (ref.kind === 'github') {
    const findExisting = async (req: PrRequest): Promise<PrResult | null> => {
      const owner = ref.project.split('/')[0];
      const res = await call('GET', `/repos/${ref.project}/pulls?state=open&head=${encodeURIComponent(`${owner}:${req.head}`)}&base=${encodeURIComponent(req.base)}`);
      if (!res.ok) return null;
      const list = (await readBody(res)).json;
      const hit = Array.isArray(list) ? list[0] : null;
      return hit ? { url: hit.html_url, number: hit.number, existing: true } : null;
    };
    return {
      ref,
      async createOrFind(req) {
        const res = await call('POST', `/repos/${ref.project}/pulls`, {
          title: req.title,
          body: req.body,
          head: req.head,
          base: req.base,
          draft: req.draft,
        });
        const body = await readBody(res);
        if (res.ok) return { url: body.json.html_url, number: body.json.number, existing: false };
        if (res.status === 422) {
          const found = await findExisting(req);
          if (found) return found;
          const msg = JSON.stringify(body.json?.errors ?? body.json?.message ?? '');
          if (/base/i.test(msg)) throw new HostError(`GitHub could not find the base branch "${req.base}" on ${ref.project}. Pass --base to run, or push it first.`);
          if (/draft/i.test(msg))
            throw new HostError('GitHub does not allow draft pull requests for this repository (private repos on a free plan). Re-run with --no-draft.');
          if (/no commits/i.test(msg)) throw new HostError('GitHub sees no difference between the branch and its base, so there is nothing to open.');
        }
        throw explain(res, body, ref, 'open the pull request');
      },
    };
  }

  const pid = encodeURIComponent(ref.project);
  const findExisting = async (req: PrRequest): Promise<PrResult | null> => {
    const res = await call(
      'GET',
      `/projects/${pid}/merge_requests?state=opened&source_branch=${encodeURIComponent(req.head)}&target_branch=${encodeURIComponent(req.base)}`,
    );
    if (!res.ok) return null;
    const list = (await readBody(res)).json;
    const hit = Array.isArray(list) ? list[0] : null;
    return hit ? { url: hit.web_url, number: hit.iid, existing: true } : null;
  };
  return {
    ref,
    async createOrFind(req) {
      const res = await call('POST', `/projects/${pid}/merge_requests`, {
        source_branch: req.head,
        target_branch: req.base,
        title: req.draft && !/^(draft:|\[draft\])/i.test(req.title) ? `Draft: ${req.title}` : req.title,
        description: req.body,
        remove_source_branch: false,
      });
      const body = await readBody(res);
      if (res.ok) return { url: body.json.web_url, number: body.json.iid, existing: false };
      if (res.status === 409) {
        const found = await findExisting(req);
        if (found) return found;
      }
      throw explain(res, body, ref, 'open the merge request');
    },
  };
}
