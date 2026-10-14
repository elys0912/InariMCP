// Limits on a `urlPattern` tool argument (a JavaScript regex the agent
// writes), checked before it is compiled: by the MCP Server for every tool
// call (tools/handlers.ts invalidRegexArgument) and again by the Extension's
// persistent background page (background/tab-wait.ts urlPatternArg), where a
// regex that backtracks for minutes would stall every tool and approval.
//
// Zod-free and import-free on purpose: the Extension bundles this module
// (scripts/build-extension.mjs SHARED_ENTRIES).

/** Longest urlPattern accepted, in UTF-16 code units. */
export const MAX_URL_PATTERN_LENGTH = 256;

/**
 * Whether a group that contains an unbounded or ranged repeat (`*`, `+`,
 * `{n,}`, `{n,m}`) is itself repeated, as in `(a+)+` or `(\w*\.)*`: the
 * shape that backtracks exponentially. A simple scan, not a regex parser:
 * escapes and character classes are skipped, a bounded `{n}` or an optional
 * `?` does not count as a repeat.
 */
function hasNestedRepeat(source: string): boolean {
  // Per open group: whether it contains a repeat so far.
  const open: boolean[] = [];
  // The atom just read is a group that contains a repeat.
  let afterRepeatingGroup = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const isRepeat = c === '*' || c === '+' || (c === '{' && /^\{\d+,\d*\}/.test(source.slice(i)));
    if (isRepeat) {
      if (afterRepeatingGroup) return true;
      if (open.length > 0) open[open.length - 1] = true;
      afterRepeatingGroup = false;
      continue;
    }
    afterRepeatingGroup = false;
    if (c === '\\') {
      i++;
    } else if (c === '[') {
      // A character class: up to the first unescaped `]` (one right after
      // `[` or `[^` is literal).
      i++;
      if (source[i] === '^') i++;
      if (source[i] === ']') i++;
      while (i < source.length && source[i] !== ']') {
        if (source[i] === '\\') i++;
        i++;
      }
    } else if (c === '(') {
      open.push(false);
    } else if (c === ')') {
      const repeats = open.pop() ?? false;
      afterRepeatingGroup = repeats;
      if (repeats && open.length > 0) open[open.length - 1] = true;
    }
  }
  return false;
}

/** Why a urlPattern is refused before compiling it, or null when it is not. */
export function urlPatternProblem(source: string): string | null {
  if (source.length > MAX_URL_PATTERN_LENGTH) {
    return `longer than ${MAX_URL_PATTERN_LENGTH} characters (${source.length})`;
  }
  if (hasNestedRepeat(source)) {
    return 'a repeated group contains a repeat (such as (a+)+), which can take exponential time; rewrite it without the nesting';
  }
  return null;
}
