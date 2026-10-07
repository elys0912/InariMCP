/** Small helpers usable everywhere (no Node or browser APIs). */

/** A plain object (not null, not an array). */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The string `code` of a thrown error (`'ENOENT'`, `'EEXIST'`, …), or undefined. */
export function errnoCode(err: unknown): string | undefined {
  if (!isRecord(err)) return undefined;
  const code = err['code'];
  return typeof code === 'string' ? code : undefined;
}

/** Zod issues as one line: `path: message; path: message` (`(root)` for an empty path). */
export function formatZodIssues(
  issues: readonly { path: readonly (string | number)[]; message: string }[],
): string {
  return issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

/** Up to 6 random base-36 characters, to keep generated names apart (not a secret). */
export function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}
