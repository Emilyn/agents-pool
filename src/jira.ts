import type { FetchLike } from './host.js';
import type { RunSource } from './types.js';
import { firstLine, truncate } from './util.js';

/**
 * Jira Cloud intake (REST v3, Basic auth with account email + API token).
 * Isolated on purpose: nothing else in the platform depends on this file.
 */

export interface JiraAuth {
  baseUrl: string;
  email: string;
  token: string;
}

export interface JiraIssue {
  key: string;
  url: string;
  summary: string;
  description: string;
  type?: string;
  status?: string;
  priority?: string;
  labels: string[];
}

const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/i;

/** Accepts `PROJ-123` or a browse / board URL that contains the key. */
export function parseJiraRef(ref: string): { key: string; baseUrl?: string } {
  const input = ref.trim();
  if (KEY_RE.test(input)) return { key: input.toUpperCase() };
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new Error(`"${ref}" is not a Jira key (like PROJ-123) or an issue URL.`);
  }
  const fromQuery = u.searchParams.get('selectedIssue');
  const fromPath = /\/browse\/([A-Za-z][A-Za-z0-9_]+-\d+)/.exec(u.pathname)?.[1];
  const key = fromQuery ?? fromPath;
  if (!key || !KEY_RE.test(key)) throw new Error(`No Jira issue key found in ${ref}.`);
  return { key: key.toUpperCase(), baseUrl: u.origin };
}

export function resolveJiraAuth(
  opts: { urlBase?: string; configBase?: string },
  env: NodeJS.ProcessEnv = process.env,
): JiraAuth {
  const baseUrl = (opts.urlBase ?? env.JIRA_BASE_URL ?? opts.configBase ?? '').trim().replace(/\/+$/, '');
  const email = env.JIRA_EMAIL?.trim() ?? '';
  const token = env.JIRA_API_TOKEN?.trim() ?? '';
  const missing = [
    !baseUrl && 'a Jira site (JIRA_BASE_URL, e.g. https://acme.atlassian.net, or paste the issue URL)',
    !email && 'JIRA_EMAIL (your Atlassian account email)',
    !token && 'JIRA_API_TOKEN (create one at https://id.atlassian.com/manage-profile/security/api-tokens)',
  ].filter(Boolean);
  if (missing.length > 0) throw new Error(`Jira is not configured. Missing: ${missing.join('; ')}.`);
  return { baseUrl, email, token };
}

const authHeader = (a: JiraAuth) => `Basic ${Buffer.from(`${a.email}:${a.token}`).toString('base64')}`;

/** Flatten Atlassian Document Format to plain text. Unknown nodes keep their text children. */
export function adfToText(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: Record<string, any> };
  const kids = (sep = '') => (n.content ?? []).map(adfToText).join(sep);
  switch (n.type) {
    case 'text':
      return n.text ?? '';
    case 'hardBreak':
      return '\n';
    case 'paragraph':
    case 'heading':
      return `${kids()}\n\n`;
    case 'bulletList':
      return (n.content ?? []).map((li) => `- ${adfToText(li).trim().replace(/\n+/g, '\n  ')}`).join('\n') + '\n\n';
    case 'orderedList':
      return (n.content ?? []).map((li, i) => `${i + 1}. ${adfToText(li).trim().replace(/\n+/g, '\n   ')}`).join('\n') + '\n\n';
    case 'listItem':
      return kids();
    case 'codeBlock':
      return `\`\`\`\n${kids()}\n\`\`\`\n\n`;
    case 'blockquote':
      return kids().trim().split('\n').map((l) => `> ${l}`).join('\n') + '\n\n';
    case 'rule':
      return '---\n\n';
    case 'mention':
      return n.attrs?.text ?? '@someone';
    case 'inlineCard':
      return n.attrs?.url ?? '';
    case 'emoji':
      return n.attrs?.text ?? n.attrs?.shortName ?? '';
    case 'table':
      return (n.content ?? []).map((row) => adfToText(row)).join('') + '\n';
    case 'tableRow':
      return (n.content ?? []).map((c) => adfToText(c).trim().replace(/\n+/g, ' ')).join(' | ') + '\n';
    default:
      return kids();
  }
}

export async function fetchIssue(key: string, auth: JiraAuth, fetchImpl: FetchLike = fetch): Promise<JiraIssue> {
  const res = await fetchImpl(
    `${auth.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,issuetype,status,labels,priority`,
    { headers: { Authorization: authHeader(auth), Accept: 'application/json' } },
  );
  if (res.status === 401) throw new Error(`Jira rejected the credentials (401). Check JIRA_EMAIL and JIRA_API_TOKEN for ${auth.baseUrl}.`);
  if (res.status === 403) throw new Error(`Jira says this account may not view ${key} (403).`);
  if (res.status === 404) throw new Error(`Jira could not find ${key} on ${auth.baseUrl} (404), or this account cannot see it.`);
  if (!res.ok) throw new Error(`Jira returned ${res.status} for ${key}: ${truncate(await res.text(), 200)}`);
  const data = (await res.json()) as any;
  const f = data.fields ?? {};
  const description = typeof f.description === 'string' ? f.description : adfToText(f.description);
  return {
    key: data.key ?? key,
    url: `${auth.baseUrl}/browse/${data.key ?? key}`,
    summary: String(f.summary ?? ''),
    description: description.replace(/\n{3,}/g, '\n\n').trim(),
    type: f.issuetype?.name,
    status: f.status?.name,
    priority: f.priority?.name,
    labels: Array.isArray(f.labels) ? f.labels : [],
  };
}

export function taskFromIssue(issue: JiraIssue, extra?: string): { task: string; source: RunSource } {
  const meta = [issue.type, issue.priority && `priority ${issue.priority}`, issue.status && `status ${issue.status}`, issue.labels.length > 0 && `labels ${issue.labels.join(', ')}`]
    .filter(Boolean)
    .join(' | ');
  const parts = [
    `${issue.key}: ${issue.summary}`,
    meta,
    issue.description ? `\n${issue.description}` : '\n(The ticket has no description.)',
    extra?.trim() ? `\nAdditional instructions from the developer:\n${extra.trim()}` : '',
  ];
  return {
    task: parts.filter((p) => p !== '').join('\n'),
    source: { type: 'jira', key: issue.key, url: issue.url, summary: firstLine(issue.summary) },
  };
}

export async function addComment(key: string, text: string, link: { label: string; url: string }, auth: JiraAuth, fetchImpl: FetchLike = fetch): Promise<void> {
  const body = {
    body: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: `${text} ` },
            { type: 'text', text: link.label, marks: [{ type: 'link', attrs: { href: link.url } }] },
          ],
        },
      ],
    },
  };
  const res = await fetchImpl(`${auth.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
    method: 'POST',
    headers: { Authorization: authHeader(auth), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Jira would not accept the comment on ${key} (${res.status}): ${truncate(await res.text(), 200)}`);
}
