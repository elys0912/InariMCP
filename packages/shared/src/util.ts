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

/** Length of shortId(). */
const SHORT_ID_LENGTH = 6;
/** Radix of shortId()'s characters (0-9, a-z). */
const SHORT_ID_RADIX = 36;

/**
 * Exactly 6 random base-36 characters (0-9, a-z), to keep generated names
 * apart (not a secret). Built per character: `Math.random().toString(36)`
 * can be shorter (or empty) for some values.
 */
export function shortId(): string {
  return Array.from({ length: SHORT_ID_LENGTH }, () =>
    Math.floor(Math.random() * SHORT_ID_RADIX).toString(SHORT_ID_RADIX),
  ).join('');
}
