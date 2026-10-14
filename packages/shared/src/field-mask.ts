// Which form fields have their value masked in what the tools return: the
// one rule of the Extension content script (content/dom.ts isMaskedField)
// and the headless backend (mcp-server headless/actions.ts get_value and
// snapshot).
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
 * passwords, one-time codes and payment card data.
 */
export const MASKED_AUTOCOMPLETE_TOKENS: readonly string[] = [
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
];

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
}

/**
 * Whether the field's value is masked: an <input> of a masked type, or an
 * <input> / <textarea> / <select> whose autocomplete has a masked token.
 * autocomplete is a space-separated token list compared without regard to
 * case (HTML), so `section-pay CC-Number` counts as well.
 */
export function isMaskedField(field: MaskFieldInfo): boolean {
  if (!VALUE_ELEMENTS.includes(field.localName)) return false;
  if (field.localName === 'input' && MASKED_INPUT_TYPES.includes(field.type.toLowerCase())) return true;
  const tokens = (field.autocomplete ?? '').toLowerCase().split(/\s+/);
  return tokens.some((token) => MASKED_AUTOCOMPLETE_TOKENS.includes(token));
}
