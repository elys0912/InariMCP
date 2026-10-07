import { describe, expect, it } from 'vitest';
import {
  applyPasswordPolicy,
  isPasswordElement,
  passwordSelectorRefusal,
  PASSWORD_REFUSAL,
} from '../src/safety/password-guard.js';
import { invalidRegexArgument } from '../src/tools/handlers.js';
import { readExtensionTree } from '../../../tests/contract/helpers/extension-source.js';

function fakeElement(localName: string, type: string, autocomplete: string | null = null): Element {
  return { localName, type, getAttribute: () => autocomplete } as unknown as Element;
}

describe('isPasswordElement', () => {
  it.each([
    ['password input', fakeElement('input', 'password'), true],
    ['current-password', fakeElement('input', 'text', 'current-password'), true],
    ['new-password', fakeElement('input', 'text', 'new-password'), true],
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
// headless-actions.test.ts.

describe('Extension contract: content.ts reads the same allowPassword key and field test', () => {
  const content = readExtensionTree('content');

  it('refuses unless options.allowPassword === true', () => {
    expect(content).toContain('options.allowPassword !== true');
  });

  it('treats the same inputs as password fields', () => {
    expect(content).toMatch(/input\.type === "password"/);
    expect(content).toMatch(/"current-password"/);
    expect(content).toMatch(/"new-password"/);
  });
});

describe('invalidRegexArgument (5.10)', () => {
  it('reports a urlPattern that does not compile', () => {
    expect(invalidRegexArgument({ urlPattern: '(' })).toMatch(/^Invalid urlPattern '\('/);
    expect(invalidRegexArgument({ urlPattern: '*.example' })).toMatch(/^Invalid urlPattern/);
  });

  it('accepts valid or absent patterns', () => {
    expect(invalidRegexArgument({ urlPattern: '^https://a\\.test/' })).toBeNull();
    expect(invalidRegexArgument({})).toBeNull();
  });
});
