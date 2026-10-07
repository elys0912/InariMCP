import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HeadlessBrowser } from '../src/headless/backend.js';
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

/**
 * The same guard on the headless backend (Playwright Firefox), where the
 * element is resolved by the server rather than by content.ts.
 * Skipped as a whole when Firefox cannot be launched.
 */
describe('headless _guardedFill (Playwright)', () => {
  const browser = new HeadlessBrowser();
  let available = false;

  beforeAll(async () => {
    try {
      await browser.start();
      available = true;
    } catch {
      available = false;
    }
  }, 60_000);

  afterAll(async () => {
    if (available) await browser.stop();
  }, 30_000);

  type Result = Record<string, unknown>;

  const PAGE = (body: string): string =>
    `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body>${body}</body></html>`)}`;

  async function load(body: string): Promise<void> {
    const r = await browser.execute('navigate', undefined, { url: PAGE(body), newTab: false });
    expect(r['success']).toBe(true);
  }

  const script = async (src: string): Promise<unknown> =>
    (await browser.execute('execute_script', undefined, { script: src }))['result'];

  function real(name: string, fn: () => Promise<void>, timeout = 30_000): void {
    it(name, async (ctx) => {
      if (!available) ctx.skip();
      await fn();
    }, timeout);
  }

  real('refuses a password field that only appears while the fill waits for it', async () => {
    await load(
      '<div id="host"></div>' +
      '<script>setTimeout(() => { document.getElementById("host").innerHTML = ' +
      '\'<input id="pw" type="password">\'; }, 300)</script>',
    );
    const r: Result = await browser.execute('type', undefined, { selector: '#pw', text: 'secret', clear: false });
    expect(r['success']).toBe(false);
    expect(String(r['error'])).toContain(PASSWORD_REFUSAL);
    expect(await script('document.getElementById("pw").value')).toBe('');
  });

  real('fills a late non-password field', async () => {
    await load(
      '<div id="host"></div>' +
      '<script>setTimeout(() => { document.getElementById("host").innerHTML = ' +
      '\'<input id="user" type="text">\'; }, 300)</script>',
    );
    expect((await browser.execute('type', undefined, { selector: '#user', text: 'alice', clear: false }))['success']).toBe(true);
    expect(await script('document.getElementById("user").value')).toBe('alice');
  });

  real('refuses a <label for> that points at a password field', async () => {
    await load('<label for="pw">Password</label><input id="pw" type="password">');
    const r: Result = await browser.execute('type', undefined, { selector: 'label[for=pw]', text: 'secret', clear: false });
    expect(r['success']).toBe(false);
    expect(String(r['error'])).toContain(PASSWORD_REFUSAL);
    expect(await script('document.getElementById("pw").value')).toBe('');
  });

  real('allows a password field when the command carries allowPassword', async () => {
    await load('<input id="pw" type="password">');
    const r: Result = await browser.execute('type', undefined, {
      selector: '#pw', text: 'secret', clear: false, allowPassword: true,
    });
    expect(r['success']).toBe(true);
    expect(await script('document.getElementById("pw").value')).toBe('secret');
  });

  real('refuses the focused password field when no selector is given', async () => {
    await load('<input id="pw" type="password">');
    await script('document.getElementById("pw").focus()');
    const r: Result = await browser.execute('type', undefined, { text: 'secret', clear: false });
    expect(r['success']).toBe(false);
    expect(String(r['error'])).toContain(PASSWORD_REFUSAL);
  });
});
