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
 * Most quantifiers of any kind (`*`, `+`, `?`, `{n}`, `{n,m}`, `{n,}`) and
 * `|` in one urlPattern, all counted together. Each is a choice the regex
 * engine can backtrack into, and choices in a row multiply: `a?` 40 times
 * then `a` 40 times, or `(a|aa)` 40 times, takes exponential time without
 * any repeated group. Ordinary URL patterns have 1 to 4.
 */
export const MAX_CHOICES = 7;

/**
 * Largest upper bound m of a `{n,m}`: one with a large m backtracks like an
 * unbounded repeat (`.{0,9999}` 8 times would get round the weight below).
 */
export const MAX_RANGE_UPPER = 32;

/**
 * Most weight of the choices of one urlPattern: about the base-2 logarithm
 * of the ways the engine can split a URL among them. An unbounded repeat
 * (`*`, `+`, `{n,}`) weighs 6, a `{n,m}` log2(m - n + 1) rounded up, `?` and
 * `|` 1, `{n}` 0. Measured on Node.js 24 against 256-character URLs that do
 * not match: at 12 the slowest accepted forms (`.*.*x`, `.*` with six `a?`,
 * `.*.{0,32}x`) take under 10 ms; `.*.*.*x` (18) takes about 250 ms.
 * `https://[^/]+\.example\.com/.*` weighs 12.
 */
export const MAX_CHOICE_WEIGHT = 12;

/** The weight of an unbounded repeat (MAX_CHOICE_WEIGHT). */
const UNBOUNDED_WEIGHT = 6;

/** `{n}`, `{n,}` or `{n,m}` at the start (`{,m}` is a literal): n, the comma, m. */
const RANGED_REPEAT_RE = /^\{(\d+)(,?)(\d*)\}/;

const NESTED_REPEAT_PROBLEM =
  'a repeated group contains a quantifier or | (such as (a+)+, (a|aa)+, (a{3})+ or (a?){25}), ' +
  'which can take exponential time; rewrite it without the nesting';

const RANGE_UPPER_PROBLEM =
  `a {n,m} with m over ${MAX_RANGE_UPPER}, which backtracks like an unbounded repeat; use * or + instead`;

const CHOICES_PROBLEM =
  `more than ${MAX_CHOICES} quantifiers and | together, which can take time that grows ` +
  'steeply with the URL length; use fewer';

const WEIGHT_PROBLEM =
  `too many ways to split the URL (weight over ${MAX_CHOICE_WEIGHT}: an unbounded repeat counts ` +
  `${UNBOUNDED_WEIGHT}, {n,m} log2(m - n + 1), ? and | 1), such as .*.*.*; use fewer repeats`;

/** A quantifier as the scan reads it. */
interface Quantifier {
  /** Characters it takes, a lazy `?` after it included. */
  length: number;
  /** It can match its atom more than once (all but `?`). */
  isRepeat: boolean;
  /** Its share of MAX_CHOICE_WEIGHT. */
  weight: number;
  /** m of a `{n,m}`; null for every other quantifier. */
  rangeUpper: number | null;
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
  /** Quantifiers and `|` read so far (MAX_CHOICES). */
  choices: number;
  /** Their weight (MAX_CHOICE_WEIGHT). */
  weight: number;
}

/** The `{...}` quantifier that starts at `i` (without a lazy `?`), or null. */
function bracedQuantifierAt(source: string, i: number): Quantifier | null {
  const range = RANGED_REPEAT_RE.exec(source.slice(i));
  if (range === null) return null;
  const [text, low, comma, high] = range;
  const length = text.length;
  if (comma === '') return { length, isRepeat: true, weight: 0, rangeUpper: null };
  if (high === '') return { length, isRepeat: true, weight: UNBOUNDED_WEIGHT, rangeUpper: null };

  const width = Math.max(1, Number(high) - Number(low) + 1);
  return { length, isRepeat: true, weight: Math.ceil(Math.log2(width)), rangeUpper: Number(high) };
}

/** The quantifier that starts at `i`, or null. */
function quantifierAt(source: string, i: number): Quantifier | null {
  const c = source[i];
  let quantifier: Quantifier | null = null;
  if (c === '*' || c === '+') {
    quantifier = { length: 1, isRepeat: true, weight: UNBOUNDED_WEIGHT, rangeUpper: null };
  } else if (c === '?') {
    quantifier = { length: 1, isRepeat: false, weight: 1, rangeUpper: null };
  } else if (c === '{') {
    quantifier = bracedQuantifierAt(source, i);
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

/** One more choice (a quantifier or `|`); the innermost open group now holds one. */
function addChoice(state: ScanState, weight: number): void {
  state.choices++;
  state.weight += weight;
  const last = state.groupHasChoice.length - 1;
  if (last >= 0) state.groupHasChoice[last] = true;
}

/** Apply a quantifier to the scan; the problem it makes at once, or null. */
function readQuantifier(quantifier: Quantifier, state: ScanState): string | null {
  if (quantifier.isRepeat && state.afterChoiceGroup) return NESTED_REPEAT_PROBLEM;
  if (quantifier.rangeUpper !== null && quantifier.rangeUpper > MAX_RANGE_UPPER) return RANGE_UPPER_PROBLEM;
  state.afterChoiceGroup = false;
  addChoice(state, quantifier.weight);
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
    case ')': {
      const hadChoice = state.groupHasChoice.pop() ?? false;
      state.afterChoiceGroup = hadChoice;
      // The parent group holds the choice too (counted once, where it was read).
      const last = state.groupHasChoice.length - 1;
      if (hadChoice && last >= 0) state.groupHasChoice[last] = true;
      return i;
    }
    case '|':
      addChoice(state, 1);
      return i;
    default:
      return i;
  }
}

/** The problem of the totals of a finished scan, or null. */
function totalsProblem(state: ScanState): string | null {
  if (state.choices > MAX_CHOICES) return CHOICES_PROBLEM;
  if (state.weight > MAX_CHOICE_WEIGHT) return WEIGHT_PROBLEM;
  return null;
}

/**
 * Why the quantifiers of `source` can make it backtrack for long, or null.
 * Refused: a repeated group (`*`, `+`, `{...}` after it) that holds a
 * quantifier or `|`, as in `(a+)+`, `(a|aa)+` or `(a?){25}`; a `{n,m}` with
 * m over MAX_RANGE_UPPER; more than MAX_CHOICES quantifiers and `|`; a
 * weight over MAX_CHOICE_WEIGHT. A simple scan, not a regex parser: escapes
 * and character classes are skipped by the JavaScript rules; a group made
 * optional by `?` is not repeated.
 */
function repeatProblem(source: string): string | null {
  const state: ScanState = { groupHasChoice: [], afterChoiceGroup: false, choices: 0, weight: 0 };
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

  return totalsProblem(state);
}

/** Why a urlPattern is refused before compiling it, or null when it is not. */
export function urlPatternProblem(source: string): string | null {
  if (source.length > MAX_URL_PATTERN_LENGTH) {
    return `longer than ${MAX_URL_PATTERN_LENGTH} characters (${source.length})`;
  }
  return repeatProblem(source);
}
