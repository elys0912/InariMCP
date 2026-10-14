import { describe, expect, it } from 'vitest';
import {
  applyPasswordPolicy,
  isPasswordElement,
  passwordSelectorRefusal,
  PASSWORD_REFUSAL,
} from '../src/safety/password-guard.js';
import { invalidRegexArgument } from '../src/tools/handlers.js';

function fakeElement(localName: string, type: string, autocomplete: string | null = null): Element {
  return { localName, type, getAttribute: () => autocomplete } as unknown as Element;
}

describe('isPasswordElement', () => {
  it.each([
    ['password input', fakeElement('input', 'password'), true],
    ['current-password', fakeElement('input', 'text', 'current-password'), true],
    ['new-password', fakeElement('input', 'text', 'new-password'), true],
    // B-KM-05: autocomplete is a space-separated, case-insensitive token list
    ['current-password with webauthn', fakeElement('input', 'text', 'current-password webauthn'), true],
    ['section- and new-password', fakeElement('input', 'text', 'section-login  new-password'), true],
    ['Current-Password', fakeElement('input', 'text', 'Current-Password'), true],
    ['a token that only contains the word', fakeElement('input', 'text', 'current-passwords'), false],
    ['text input', fakeElement('input', 'text', 'username'), false],
    ['textarea', fakeElement('textarea', 'textarea'), false],
    ['nothing focused', null, false],
    ['label of a password input', { localName: 'label', control: fakeElement('input', 'password') } as unknown as Element, true],
    ['label without control', { localName: 'label', control: null } as unknown as Element, false],
  ])('%s → %s', (_label, el, expected) => {
    expect(isPasswordElement(el)).toBe(expected);
  });
});

describe('passwordSelectorRefusal', () => {
  it.each([
    ['fox_type', { selector: 'input[type="password"]' }],
    ['fox_type', { selector: "input[type='PASSWORD']" }],
    ['fox_set_value', { selector: 'input[type=password]' }],
    ['fox_set_value', { selector: 'input[autocomplete="current-password"]' }],
    ['fox_type', { xpath: '//input[@type="password"]', selector: undefined }],
  ])('refuses %s %j', (tool, args) => {
    expect(passwordSelectorRefusal(tool, args, false)).toBe(PASSWORD_REFUSAL);
  });

  it('allows other locators, other tools, and everything when allowed', () => {
    expect(passwordSelectorRefusal('fox_type', { selector: '#user' }, false)).toBeNull();
    expect(passwordSelectorRefusal('fox_click', { selector: 'input[type=password]' }, false)).toBeNull();
    // Enter or Tab on a password field stays allowed: the backend judges the key.
    expect(passwordSelectorRefusal('fox_press_key', { selector: 'input[type=password]' }, false)).toBeNull();
    expect(passwordSelectorRefusal('fox_type', { selector: 'input[type=password]' }, true)).toBeNull();
  });
});

describe('applyPasswordPolicy', () => {
  it('sets allowPassword from the config on fox_type / fox_set_value, over any caller value', () => {
    const data: Record<string, unknown> = { allowPassword: true };
    applyPasswordPolicy('fox_type', data, false);
    expect(data['allowPassword']).toBe(false);
    const data2: Record<string, unknown> = {};
    applyPasswordPolicy('fox_set_value', data2, true);
    expect(data2['allowPassword']).toBe(true);
  });

  it('sets it on fox_press_key too: headless key presses are real input (H-1)', () => {
    const data: Record<string, unknown> = { allowPassword: true };
    applyPasswordPolicy('fox_press_key', data, false);
    expect(data['allowPassword']).toBe(false);
  });

  it('leaves other tools alone', () => {
    const data: Record<string, unknown> = {};
    applyPasswordPolicy('fox_click', data, false);
    expect(data).toEqual({});
  });
});

// The headless backend's checks of the element written to (Firefox) are in
// headless-actions.test.ts; the Extension's (masking, refusal, allowPassword)
// in tests/contract/extension-content.test.ts.

describe('invalidRegexArgument (5.10)', () => {
  it('reports a urlPattern that does not compile', () => {
    expect(invalidRegexArgument({ urlPattern: '(' })).toMatch(/^Invalid urlPattern '\('/);
    expect(invalidRegexArgument({ urlPattern: '*.example' })).toMatch(/^Invalid urlPattern/);
  });

  it('refuses a urlPattern over the limits of shared url-pattern-limit.ts (Fs-04)', () => {
    expect(invalidRegexArgument({ urlPattern: '(a+)+$' })).toMatch(/^Invalid urlPattern: a repeated group contains a quantifier or \|/);
    expect(invalidRegexArgument({ urlPattern: 'a'.repeat(257) })).toMatch(/^Invalid urlPattern: longer than 256/);
  });

  it('accepts valid or absent patterns', () => {
    expect(invalidRegexArgument({ urlPattern: '^https://a\\.test/' })).toBeNull();
    expect(invalidRegexArgument({})).toBeNull();
  });
});
