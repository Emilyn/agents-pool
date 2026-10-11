/**
 * Write scope: which paths an agent may change. Patterns are evaluated against repo-relative paths with
 * forward slashes. A pattern starting with `!` excludes. An empty list means read-only.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$+.()|{}[]'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function pathAllowed(path: string, scope: string[]): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  let allowed = false;
  for (const pattern of scope) {
    if (pattern.startsWith('!')) {
      if (globToRegExp(pattern.slice(1)).test(normalized)) return false;
    } else if (globToRegExp(pattern).test(normalized)) {
      allowed = true;
    }
  }
  return allowed;
}
