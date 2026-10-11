import type { z } from 'zod';

/** Find the JSON an agent was asked to end its reply with: the last fenced json block, else the outermost braces. */
export function extractJsonText(text: string): string | null {
  const blocks = [...text.matchAll(/```([a-zA-Z]*)[ \t]*\r?\n([\s\S]*?)```/g)].filter(
    (m) => (m[1] ?? '').toLowerCase() === 'json' || (m[1] ?? '') === '',
  );
  const last = blocks.at(-1);
  if (last?.[2]) return last[2].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return null;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseStructured<T>(text: string, schema: z.ZodType<T, unknown>): Parsed<T> {
  const raw = extractJsonText(text);
  if (raw === null) return { ok: false, error: 'no JSON block found in the reply' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { ok: false, error: `JSON did not match the expected shape: ${issues}` };
  }
  return { ok: true, value: result.data };
}
