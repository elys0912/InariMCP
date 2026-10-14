// Which form fields have their value masked in what the tools return: the
// one rule of the Extension content script (content/dom.ts isMaskedField)
// and the headless backend (mcp-server headless/actions.ts elementFacts).
// Also the selectors a reading tool refuses because they could test a
// masked value instead of returning it (readSelectorProblem).
//
// Zod-free and import-free on purpose: the Extension bundles this module
// (scripts/build-extension.mjs SHARED_ENTRIES).
//
// The mask is unconditional. allow_password_typing (safety.json) only lets
// the tools type into a password field; it unmasks nothing, for password
// fields and the other masked fields alike.

/** What a masked value reads as, on every backend. */
export const MASKED_VALUE = '[MASKED]';

/** `<input type>` values whose field is masked (compared in lower case). */
export const MASKED_INPUT_TYPES: readonly string[] = ['password', 'hidden'];

/**
 * autocomplete tokens whose field is masked (HTML autofill field names):
 * passwords and one-time codes. Payment card fields are masked by
 * MASKED_AUTOCOMPLETE_PREFIX.
 */
export const MASKED_AUTOCOMPLETE_TOKENS: readonly string[] = [
  'current-password',
  'new-password',
  'one-time-code',
];

/**
 * autocomplete tokens starting with this are masked: every payment card
 * field of HTML autofill (cc-number, cc-csc, cc-exp*, cc-name and the other
 * name parts, cc-type), so the card holder's name is not sent either.
 */
export const MASKED_AUTOCOMPLETE_PREFIX = 'cc-';

/** Elements that hold a form value (a card expiry is often a <select>). */
const VALUE_ELEMENTS: readonly string[] = ['input', 'textarea', 'select'];

/** What the rule looks at, read from the element by each backend. */
export interface MaskFieldInfo {
  /** Element.localName (lower case in HTML and XML documents alike). */
  localName: string;
  /** HTMLInputElement.type for an <input>; ignored for other elements. */
  type: string;
  /** The autocomplete attribute, or null when absent. */
  autocomplete: string | null;
  /**
   * For an <option>: the <select> it belongs to (Element.closest('select')),
   * null when it has none. Ignored for other elements.
   */
  select?: MaskFieldInfo | null;
}

function isMaskedAutocompleteToken(token: string): boolean {
  return token.startsWith(MASKED_AUTOCOMPLETE_PREFIX) || MASKED_AUTOCOMPLETE_TOKENS.includes(token);
}

/**
 * Whether the field's value is masked: an <input> of a masked type, an
 * <input> / <textarea> / <select> whose autocomplete has a masked token, or
 * an <option> of such a <select> (its value and text tell the value of the
 * select). autocomplete is a space-separated token list compared without
 * regard to case (HTML), so `section-pay CC-Number` counts as well.
 */
export function isMaskedField(field: MaskFieldInfo): boolean {
  if (field.localName === 'option') {
    return field.select !== undefined && field.select !== null && isMaskedField(field.select);
  }
  if (!VALUE_ELEMENTS.includes(field.localName)) return false;
  if (field.localName === 'input' && MASKED_INPUT_TYPES.includes(field.type.toLowerCase())) return true;

  const tokens = (field.autocomplete ?? '').toLowerCase().split(/\s+/);
  return tokens.some(isMaskedAutocompleteToken);
}

/**
 * A text as the tools return it: MASKED_VALUE when it is the text of a
 * masked field (`masked`: isMaskedField of its element) and not empty, else
 * as it is. An empty text stays empty, so a password input (no text) does
 * not read as [MASKED] text.
 */
export function maskedText(text: string, masked: boolean): string {
  return text !== '' && masked ? MASKED_VALUE : text;
}

// ---------------------------------------------------------------------------
// Selectors of the reading tools
// ---------------------------------------------------------------------------

/**
 * Longest CSS selector a reading tool accepts, in UTF-16 code units. Enough
 * for any selector written by hand or generated from a page (a long
 * `#id > div:nth-of-type(n) > …` path is a few hundred), and it keeps the
 * check and the page's own selector matching bounded.
 */
export const MAX_READ_SELECTOR_LENGTH = 1024;

/** The rule of readSelectorProblem in one sentence, for the tool descriptions. */
export const READ_SELECTOR_RULE_TEXT =
  'A selector that tests the value or selected attribute (such as [value^="a"] or option[selected]) or uses ' +
  `:checked or :default is refused, as is one longer than ${MAX_READ_SELECTOR_LENGTH} characters: ` +
  'it could tell a masked value one guess at a time.';

/**
 * A CSS escape: up to 6 hex digits and one optional white space, or one
 * other character. Sticky: matched at lastIndex, so the scan stays linear.
 */
const CSS_ESCAPE_RE = /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([^\n\r\f]))/y;

const BACKSLASH = '\\';

/** Largest Unicode code point; a CSS escape above it (or of 0) reads as U+FFFD. */
const MAX_CODE_POINT = 0x10ffff;
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);

/** A piece of a selector as normalizedSelector reads it, and the index of the next piece. */
interface SyntaxPiece {
  text: string;
  next: number;
}

/** The CSS escape at `start` (a backslash): the character it stands for. */
function cssEscapeAt(selector: string, start: number): SyntaxPiece {
  CSS_ESCAPE_RE.lastIndex = start;
  const match = CSS_ESCAPE_RE.exec(selector);
  // A backslash before a line break, or at the end, escapes nothing.
  if (match === null) return { text: '', next: start + 1 };

  const [all, hex, char] = match;
  const next = start + all.length;
  if (hex === undefined) return { text: char ?? '', next };

  const codePoint = parseInt(hex, 16);
  const valid = codePoint > 0 && codePoint <= MAX_CODE_POINT;
  return { text: valid ? String.fromCodePoint(codePoint) : REPLACEMENT_CHARACTER, next };
}

/** The string that opens at `start` (a quote), emptied. */
function cssStringAt(selector: string, start: number): SyntaxPiece {
  const quote = selector[start];
  let i = start + 1;
  while (i < selector.length && selector[i] !== quote) {
    i += selector[i] === BACKSLASH ? 2 : 1;
  }
  return { text: '""', next: Math.min(i + 1, selector.length) };
}

/** The comment that opens at `start` (`/*`), removed. */
function cssCommentAt(selector: string, start: number): SyntaxPiece {
  const close = selector.indexOf('*/', start + 2);
  return { text: '', next: close === -1 ? selector.length : close + 2 };
}

function syntaxPieceAt(selector: string, i: number): SyntaxPiece {
  const c = selector[i];
  if (c === '"' || c === "'") return cssStringAt(selector, i);
  if (c === '/' && selector[i + 1] === '*') return cssCommentAt(selector, i);
  if (c === BACKSLASH) return cssEscapeAt(selector, i);
  return { text: c, next: i + 1 };
}

/**
 * The selector normalized for the checks below: CSS escapes decoded,
 * comments and white space removed, strings emptied (`""`), lower case:
 * `[ VAL\75 e ]` reads as `[value]`. Not a CSS parser: it only has to leave
 * no spelling of an attribute name or a pseudo-class that the checks would
 * miss (it may join what CSS keeps apart, which only refuses more).
 */
function normalizedSelector(selector: string): string {
  let out = '';
  let i = 0;
  while (i < selector.length) {
    const piece = syntaxPieceAt(selector, i);
    out += piece.text;
    i = piece.next;
  }
  return out.replace(/\s+/g, '').toLowerCase();
}

/**
 * An attribute selector on `value` or `selected` (any namespace, any
 * operator): `[value]`, `[value^="a"]`, `[*|value="a" i]`, `option[selected]`.
 * The value attribute is the value of a hidden field and the default of the
 * others; the selected attribute is the option a page drew as chosen (often
 * the saved one). The namespace part stops at `[` as well, so the match is
 * linear in the length of the selector.
 */
const SELECTION_ATTRIBUTE_RE = /\[(?:[^\]|[]*\|)?(?:value|selected)(?=[\]=~|^$*]|$)/;

/** :checked matches the chosen option of a select (and checked boxes), :default the option drawn as chosen. */
const SELECTION_PSEUDO_RE = /:(?:checked|default)/;

/**
 * readSelectorProblem without the length limit: what the selector tests.
 * Linear in the length of the selector
 * (packages/shared/tests/field-mask.test.ts times it).
 */
export function selectorTestProblem(selector: string): string | null {
  const normalized = normalizedSelector(selector);
  if (SELECTION_ATTRIBUTE_RE.test(normalized)) {
    return 'it tests the value or selected attribute ([value…], [selected]), which can tell a masked value ' +
      'one guess at a time; find the element by id, name, type or position instead';
  }
  if (SELECTION_PSEUDO_RE.test(normalized)) {
    return 'it uses :checked or :default, which can tell which option of a masked field is chosen; ' +
      'find the element without them';
  }
  return null;
}

/**
 * Why a reading tool refuses this CSS selector, or null when it does not.
 * Such a selector would not return a masked value, but it can test one: the
 * match count of `input[name=csrf][value^="a"]`, or whether a wait for it
 * ends, tells the value one guess at a time, and `option:checked` or
 * `option[selected]` picks the chosen option of a select. Refused: an
 * attribute selector on `value` or `selected`, the :checked and :default
 * pseudo-classes, however they are spelled (case, escapes, comments, white
 * space), and a selector longer than MAX_READ_SELECTOR_LENGTH.
 */
export function readSelectorProblem(selector: string): string | null {
  if (selector.length > MAX_READ_SELECTOR_LENGTH) {
    return `it is longer than ${MAX_READ_SELECTOR_LENGTH} characters (${selector.length})`;
  }
  return selectorTestProblem(selector);
}

/**
 * Refuse the CSS selector of a reading command (readSelectorProblem), before
 * it is used: the Extension's content script and the headless backend.
 * Nothing to check without a selector.
 */
export function assertReadSelector(selector: string | undefined): void {
  if (selector === undefined) return;

  const problem = readSelectorProblem(selector);
  if (problem !== null) throw new Error(`Selector refused: ${problem}`);
}

