import { randomBytes } from 'node:crypto';

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 3))}...`;
}

export function tail(s: string, n: number): string {
  return s.length <= n ? s : `...${s.slice(s.length - Math.max(0, n - 3))}`;
}

export function firstLine(s: string): string {
  return (s.split('\n')[0] ?? '').trim();
}

export function newRunId(now: Date = new Date()): string {
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}
