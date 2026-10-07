/**
 * Password-field guard: the one definition used by the MCP Server, the
 * headless backend and (by contract) the Extension content script.
 *
 * The decision travels with the command: handlers.ts sets
 * `data.allowPassword` from safety.json `allow_password_typing` on every
 * fox_type / fox_set_value / fox_press_key command (overriding any caller
 * argument), and
 * each backend refuses a password field unless it is `true`:
 *   - Extension: content.ts assertNotPasswordField() reads options.allowPassword
 *   - headless:  headless/actions.ts checks the element with isPasswordElement()
 *                (the focused one through iframes / shadow roots:
 *                headless/focus.ts focusedIsPassword); press_key too, for
 *                every key that may edit the field
 *   - Extension press_key sends synthetic key events, which enter no text,
 *     and does not read allowPassword
 * The selector check below only refuses early what is visibly a password
 * field; the backends check the element actually targeted.
 */

/** Tools that write text into an element (the selector check below refuses them early). */
export const PASSWORD_GUARDED_TOOLS: ReadonlySet<string> = new Set(['fox_type', 'fox_set_value']);

/**
 * Tools whose command carries the policy (applyPasswordPolicy): the guarded
 * ones and fox_press_key. Headless key presses are real input, so a key
 * pressed on a password field enters text there (headless/actions.ts
 * pressKey refuses it). fox_press_key has no early selector refusal: keys
 * that do not edit (Enter, Tab, ...) stay allowed on a password field.
 */
export const PASSWORD_POLICY_TOOLS: ReadonlySet<string> =
  new Set([...PASSWORD_GUARDED_TOOLS, 'fox_press_key']);

export const PASSWORD_REFUSAL =
  'Refused: target is a password field. Use the browser’s own password manager ' +
  '(autofill) for credentials, or set "allow_password_typing": true in the safety ' +
  'config if you really want automated password entry.';

const PASSWORD_SELECTOR_RE =
  /type\s*=\s*["']?password|autocomplete\s*=\s*["']?(?:current|new)-password/i;

/**
 * Same test as the Extension's isPasswordField(). Self-contained (no outer
 * references), so Playwright can serialise it into the page.
 *
 * Element kinds are told by localName, not tagName: tagName is upper case
 * in HTML documents only, lower case in XML ones (application/xhtml+xml),
 * where an upper-case comparison would miss every password field.
 */
export function isPasswordElement(el: Element | null): boolean {
  const isLabel = (e: Element): e is HTMLLabelElement => e.localName === 'label';
  const isInput = (e: Element): e is HTMLInputElement => e.localName === 'input';
  // Playwright's fill() on a <label> fills its control.
  const target = el !== null && isLabel(el) ? el.control : el;
  if (target === null || !isInput(target)) return false;
  const autocomplete = target.getAttribute('autocomplete');
  return (
    target.type === 'password' ||
    autocomplete === 'current-password' ||
    autocomplete === 'new-password'
  );
}

/**
 * The focused element of the current document, followed into open shadow
 * roots (document.activeElement is only the shadow host). An <iframe> is
 * returned as is: its document is another frame (headless/focus.ts follows
 * it). Self-contained, so Playwright can serialise it into the page.
 */
export function deepActiveElement(): Element | null {
  let el: Element | null = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/** Early refusal when the locator itself names a password field. */
export function passwordSelectorRefusal(
  toolName: string,
  args: Record<string, unknown>,
  allowPasswordTyping: boolean,
): string | null {
  if (allowPasswordTyping || !PASSWORD_GUARDED_TOOLS.has(toolName)) return null;
  for (const key of ['selector', 'xpath']) {
    const locator = args[key];
    if (typeof locator === 'string' && PASSWORD_SELECTOR_RE.test(locator)) {
      return PASSWORD_REFUSAL;
    }
  }
  return null;
}

/** Put the policy into the command data the backends read. */
export function applyPasswordPolicy(
  toolName: string,
  data: Record<string, unknown>,
  allowPasswordTyping: boolean,
): void {
  if (PASSWORD_POLICY_TOOLS.has(toolName)) {
    data['allowPassword'] = allowPasswordTyping;
  }
}
