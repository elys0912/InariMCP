// Limits on a `urlPattern` tool argument (a JavaScript regex the agent
// writes), checked before it is compiled: by the MCP Server for every tool
// call (tools/handlers.ts invalidRegexArgument) and again by the Extension's
// persistent background page (background/tab-wait.ts urlPatternArg), where a
// regex that backtracks for minutes would stall every tool and approval.
//
// Zod-free and import-free on purpose: the Extension bundles this module
// (scripts/build-extension.mjs SHARED_ENTRIES).

/**
 * Longest urlPattern accepted, in UTF-16 code units. Long enough for a URL
 * or a host / path pattern; a fixed bound keeps the time of this check and
 * of compiling the pattern bounded as well.
 */
export const MAX_URL_PATTERN_LENGTH = 256;

/**
 * Most unbounded repeats (`*`, `+`, `{n,}`) in one urlPattern. Each one can
 * try every split of the URL that the others leave, so the backtracking
 * grows with the URL length to the power of their number. The eighth is
 * refused, as in `a*a*a*a*a*a*a*a*b`.
 */
export const MAX_UNBOUNDED_REPEATS = 7;

/** `{n}`, `{n,}` or `{n,m}` at the start: a repeat with its range in braces (`{,m}` is a literal). */
const RANGED_REPEAT_RE = /^\{\d+(?:,\d*)?\}/;

const NESTED_REPEAT_PROBLEM =
  'a repeated group contains a quantifier or | (such as (a+)+, (a|aa)+ or (a?){25}), which can ' +
  'take exponential time; rewrite it without the nesting';

const UNBOUNDED_REPEATS_PROBLEM =
  `more than ${MAX_UNBOUNDED_REPEATS} unbounded repeats (*, + or {n,}), which can take time that ` +
  'grows steeply with the URL length; use fewer';

/** A quantifier as the scan reads it. */
interface Quantifier {
  /** Characters it takes, a lazy `?` after it included. */
  length: number;
  /** It can match its atom more than once (all but `?`). */
  isRepeat: boolean;
  /** It has no upper bound (`*`, `+`, `{n,}`). */
  isUnbounded: boolean;
}

/** The scan's state, from the start of the pattern up to the current character. */
interface ScanState {
  /**
   * Per open group: whether it holds a quantifier or `|` so far (a choice
   * the regex engine can backtrack into).
   */
  groupHasChoice: boolean[];
  /** The atom just read is a group that holds a quantifier or `|`. */
  afterChoiceGroup: boolean;
  unboundedRepeats: number;
}

/** The quantifier that starts at `i`, or null. */
function quantifierAt(source: string, i: number): Quantifier | null {
  const c = source[i];
  let quantifier: Quantifier | null = null;
  if (c === '*' || c === '+') {
    quantifier = { length: 1, isRepeat: true, isUnbounded: true };
  } else if (c === '?') {
    quantifier = { length: 1, isRepeat: false, isUnbounded: false };
  } else if (c === '{') {
    const range = RANGED_REPEAT_RE.exec(source.slice(i));
    if (range !== null) quantifier = { length: range[0].length, isRepeat: true, isUnbounded: range[0].endsWith(',}') };
  }
  if (quantifier !== null && source[i + quantifier.length] === '?') quantifier.length++;
  return quantifier;
}

/**
 * Index of the `]` that closes the character class opened at `open` (or
 * source.length). JavaScript closes a class at its first unescaped `]`,
 * also right after `[` or `[^`: `[]` matches nothing and `[^]` any
 * character (unlike POSIX, where such a `]` is literal).
 */
function endOfCharacterClass(source: string, open: number): number {
  let i = source[open + 1] === '^' ? open + 2 : open + 1;
  while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
  return i;
}

/** The innermost open group now holds a quantifier or `|`. */
function markChoice(state: ScanState): void {
  const last = state.groupHasChoice.length - 1;
  if (last >= 0) state.groupHasChoice[last] = true;
}

/** Apply a quantifier to the scan; the problem it makes, or null. */
function readQuantifier(quantifier: Quantifier, state: ScanState): string | null {
  if (quantifier.isRepeat && state.afterChoiceGroup) return NESTED_REPEAT_PROBLEM;
  if (quantifier.isUnbounded) state.unboundedRepeats++;
  if (state.unboundedRepeats > MAX_UNBOUNDED_REPEATS) return UNBOUNDED_REPEATS_PROBLEM;
  state.afterChoiceGroup = false;
  markChoice(state);
  return null;
}

/** Read the atom or group bracket at `i`; the index of its last character. */
function readAtom(source: string, i: number, state: ScanState): number {
  state.afterChoiceGroup = false;
  switch (source[i]) {
    case '\\':
      return i + 1;
    case '[':
      return endOfCharacterClass(source, i);
    case '(':
      state.groupHasChoice.push(false);
      // The `?` of (?: (?= (?! (?<= (?<! (?<name> is no quantifier.
      return source[i + 1] === '?' ? i + 1 : i;
    case ')':
      state.afterChoiceGroup = state.groupHasChoice.pop() ?? false;
      if (state.afterChoiceGroup) markChoice(state);
      return i;
    case '|':
      markChoice(state);
      return i;
    default:
      return i;
  }
}

/**
 * Why the quantifiers of `source` can make it backtrack for long, or null.
 * Refused: a repeated group (`*`, `+`, `{...}` after it) that holds a
 * quantifier or `|`, as in `(a+)+`, `(a|aa)+` or `(a?){25}`; more than
 * MAX_UNBOUNDED_REPEATS unbounded repeats. A simple scan, not a regex
 * parser: escapes and character classes are skipped by the JavaScript
 * rules; a group made optional by `?` is not repeated.
 */
function repeatProblem(source: string): string | null {
  const state: ScanState = { groupHasChoice: [], afterChoiceGroup: false, unboundedRepeats: 0 };
  let i = 0;
  while (i < source.length) {
    const quantifier = quantifierAt(source, i);
    if (quantifier === null) {
      i = readAtom(source, i, state) + 1;
      continue;
    }
    const problem = readQuantifier(quantifier, state);
    if (problem !== null) return problem;
    i += quantifier.length;
  }

  return null;
}

/** Why a urlPattern is refused before compiling it, or null when it is not. */
export function urlPatternProblem(source: string): string | null {
  if (source.length > MAX_URL_PATTERN_LENGTH) {
    return `longer than ${MAX_URL_PATTERN_LENGTH} characters (${source.length})`;
  }
  return repeatProblem(source);
}
