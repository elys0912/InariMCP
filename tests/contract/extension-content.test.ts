/**
 * Extension content script: element location and typing fixes of WP5
 * (review 3.A1 / 6.Critical, 3.A11, 3.A13, 6.High). The helpers are
 * imported from content/dom.ts and content/input.ts (modules without
 * top-level side effects); DOM behaviour itself needs a real browser.
 *
 * The "real DOM" blocks below run the content modules in a headless Firefox
 * (Playwright): esbuild bundles them the way the extension build does, the
 * bundle is injected into a page served over HTTP, and `browser.*`,
 * `wrappedJSObject` and `exportFunction` (the Firefox content-script
 * sandbox) are stubbed in the page first. Skipped when Firefox cannot be
 * launched, except on CI or with INARI_REQUIRE_FIREFOX (npm run test:firefox),
 * where that fails the run (helpers/real-firefox.ts).
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { build, type Plugin } from 'esbuild';
import { firefox, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAPTCHA_BANNER_ID } from '../../packages/extension/src/content/constants.ts';
import { readExtensionSource, readExtensionTree } from './helpers/extension-source.js';
import { skipOrFailWithoutFirefox } from './helpers/real-firefox.js';

interface ContentFns {
  escapeXPathString(s: string): string;
  textLocatorXPath(text: string): string | null;
  locatorOf(o: Record<string, unknown>): Record<string, unknown>;
  locatorWithoutText(o: Record<string, unknown>): Record<string, unknown>;
  typingDelay(length: number, requested: unknown, budgetMs: number): number;
}

let fns: ContentFns;

beforeAll(async () => {
  const dom = await import('../../packages/extension/src/content/dom.ts');
  const input = await import('../../packages/extension/src/content/input.ts');
  fns = {
    escapeXPathString: dom.escapeXPathString,
    textLocatorXPath: dom.textLocatorXPath,
    locatorOf: dom.locatorOf as unknown as ContentFns['locatorOf'],
    locatorWithoutText: dom.locatorWithoutText as unknown as ContentFns['locatorWithoutText'],
    typingDelay: input.typingDelay,
  };
});

// ---------------------------------------------------------------------------
// Real DOM harness (headless Firefox)
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** `@inari-mcp/shared/<entry>` from its sources, as scripts/build-extension.mjs resolves it (no build needed). */
const sharedSources: Plugin = {
  name: 'shared-sources',
  setup(b) {
    b.onResolve({ filter: /^@inari-mcp\/shared\/[a-z-]+$/ }, (args) => ({
      path: fileURLToPath(new URL(`../../packages/shared/src/${args.path.slice('@inari-mcp/shared/'.length)}.ts`, import.meta.url)),
    }));
  },
};

/** The content modules, bundled like scripts/build-extension.mjs does. */
async function bundleSource(contents: string): Promise<string> {
  const out = await build({
    stdin: { contents, resolveDir: ROOT, sourcefile: 'entry.ts', loader: 'ts' },
    plugins: [sharedSources],
    bundle: true,
    format: 'iife',
    target: ['firefox115'],
    write: false,
    logLevel: 'silent',
  });
  const file = out.outputFiles?.[0];
  if (!file) throw new Error('esbuild produced no output');
  return file.text;
}

const LIB_ENTRY = `
import * as dom from "./packages/extension/src/content/dom";
import * as input from "./packages/extension/src/content/input";
import * as wait from "./packages/extension/src/content/wait";
import * as inspect from "./packages/extension/src/content/inspect";
import * as overlay from "./packages/extension/src/content/overlay";
import * as captcha from "./packages/extension/src/content/captcha";
(globalThis as Record<string, unknown>).__fox = { dom, input, wait, inspect, overlay, captcha };
`;

/** What the Firefox content-script sandbox gives the script, stubbed. */
const PRELUDE = `
window.browser = {
  i18n: { getMessage: (key) => key },
};
window.wrappedJSObject = window;
window.exportFunction = (fn, target, opts) => {
  if (opts && opts.defineAs) target[opts.defineAs] = fn;
  return fn;
};
`;

let browserInstance: Browser | null = null;
let context: BrowserContext | null = null;
let server: Server | null = null;
let base = '';
let libBundle = '';
let page: Page | null = null;
let available = false;

beforeAll(async () => {
  try {
    libBundle = await bundleSource(LIB_ENTRY);
    // /hang never answers, so a fetch to it stays in flight.
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/hang') return;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>${url.searchParams.get('html') ?? ''}</body></html>`);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browserInstance = await firefox.launch({ headless: true });
    context = await browserInstance.newContext();
    available = true;
  } catch (err) {
    skipOrFailWithoutFirefox(err);
    available = false;
  }
}, 120_000);

afterAll(async () => {
  await page?.close().catch(() => undefined);
  await context?.close().catch(() => undefined);
  await browserInstance?.close().catch(() => undefined);
  // The /hang requests keep their sockets open.
  (server as unknown as { closeAllConnections?: () => void } | null)?.closeAllConnections?.();
  server?.close();
}, 30_000);

/** A page with `body` and the bundle injected (one page at a time). */
async function load(body: string): Promise<void> {
  await page?.close();
  page = await context!.newPage();
  await page.goto(`${base}/?html=${encodeURIComponent(body)}`);
  await page.addScriptTag({ content: PRELUDE });
  await page.addScriptTag({ content: libBundle });
}

/** Run `body` in the page; `f` is the bundle's modules, `sleep` a delay. */
async function run<T>(body: string): Promise<T> {
  return (await page!.evaluate(
    `(async () => {
       const f = window.__fox;
       const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
       ${body}
     })()`,
  )) as T;
}

function real(name: string, fn: () => Promise<void>, timeout = 30_000): void {
  it(name, async (ctx) => {
    if (!available) ctx.skip();
    await fn();
  }, timeout);
}

describe('3.A1 fox_type: `text` is what to type, not a locator', () => {
  it('the locator of a placeholder-only fox_type has no text (nor other data)', () => {
    const data = { text: 'hello', placeholder: 'Search', clear: true, pressEnter: true, delay: 0 };
    expect(fns.locatorWithoutText(data)).toEqual({ placeholder: 'Search' });
    // fox_click keeps text as its locator
    expect(fns.locatorOf({ text: 'Sign in', doubleClick: false })).toEqual({ text: 'Sign in' });
  });

  it('delay 0 is honoured and long texts stay within the typing budget', () => {
    expect(fns.typingDelay(10, 0, 10_000)).toBe(0);
    expect(fns.typingDelay(10, undefined, 10_000)).toBe(50);
    // 600 characters at the default 50 ms used to take 30 s
    expect(600 * fns.typingDelay(600, 50, 10_000)).toBeLessThanOrEqual(10_000);
  });
});

describe('3.A13 text locator', () => {
  it('matches the whole (normalized) text of the innermost element, quoted safely', () => {
    const xpath = fns.textLocatorXPath("  Don't\n  go ")!;
    expect(xpath).toContain(`contains(normalize-space(.), "Don't go")`);
    expect(xpath).not.toContain('text()');
    expect(xpath).toMatch(/\[not\(\*\[/); // innermost: no child element also matches
    expect(fns.textLocatorXPath('   ')).toBeNull();
  });
});

// Fo-10 / Po-13: the "inspect element" menu entry handed its result to
// nobody, so InariMCP removed it with the contextmenu listener it needed.
describe('no "inspect element" context menu', () => {
  it('the menu has the screenshot entry only; content.ts listens for no contextmenu event', () => {
    const menu = readExtensionSource('background/context-menu.ts');
    expect([...menu.matchAll(/contextMenus\.create\(/g)]).toHaveLength(1);
    expect(menu).not.toMatch(/inspect/i);
    // A right click (fox_click with rightClick) still dispatches a contextmenu event.
    expect(readExtensionTree('content')).not.toMatch(/addEventListener\(\s*["'`]contextmenu/);
    // WP38: nor does the contextMenus type declare pageX / pageY.
    expect(readExtensionSource('types/browser.d.ts')).not.toMatch(/page[XY]\?: number/);
  });
});

describe('3.A13 findByText in a real DOM', () => {
  real('picks the innermost match, across child elements, never script / style', async () => {
    await load(
      '<script>var a = "Sign in";</script><style>#x::after{content:"Sign in"}</style>' +
      '<div id="wrap"><button id="go"><b>Sign</b> in</button></div>',
    );
    expect(await run(`return f.dom.findElement({ text: 'Sign in' }).id;`)).toBe('go');
  });

  real('prefers the visible and enabled match, else the visible one', async () => {
    await load(
      '<button id="off" disabled>Go now</button>' +
      '<button id="hidden" style="display:none">Go now</button>' +
      '<button id="ok">Go now</button>',
    );
    expect(await run(`return f.dom.findElement({ text: 'Go now' }).id;`)).toBe('ok');
    expect(
      await run(`document.getElementById('ok').remove();
                 return f.dom.findElement({ text: 'Go now' }).id;`),
    ).toBe('off');
  });
});

describe('pressEnter: implicit form submission', () => {
  const SUBMIT_SPY = `document.forms[0].addEventListener('submit', (e) => {
    e.preventDefault();
    window.__submits = (window.__submits || 0) + 1;
  });`;

  real('submits through the default submit button', async () => {
    await load('<form><input id="q" name="q"><button type="submit">Go</button></form>');
    expect(
      await run(`${SUBMIT_SPY}
                 const r = await f.input.performType({ selector: '#q', text: 'hi', instant: true, pressEnter: true });
                 return [r.enter, window.__submits || 0];`),
    ).toEqual(['submitted', 1]);
  });

  real('does not submit when a keydown handler cancels the key', async () => {
    await load('<form><input id="q"><button type="submit">Go</button></form>');
    expect(
      await run(`${SUBMIT_SPY}
                 document.getElementById('q').addEventListener('keydown', (e) => {
                   if (e.key === 'Enter') e.preventDefault();
                 });
                 const r = await f.input.performType({ selector: '#q', text: 'hi', instant: true, pressEnter: true });
                 return [r.enter, window.__submits || 0];`),
    ).toEqual(['prevented', 0]);
  });

  real('never submits a textarea', async () => {
    await load('<form><textarea id="q"></textarea><button type="submit">Go</button></form>');
    expect(
      await run(`${SUBMIT_SPY}
                 const r = await f.input.performType({ selector: '#q', text: 'hi', instant: true, pressEnter: true });
                 return [r.enter, window.__submits || 0];`),
    ).toEqual(['none', 0]);
  });

  real('is blocked for two text fields without a submit button', async () => {
    await load('<form><input id="q"><input name="b"><button type="button">x</button></form>');
    expect(
      await run(`${SUBMIT_SPY}
                 const r = await f.input.performType({ selector: '#q', text: 'hi', instant: true, pressEnter: true });
                 return [r.enter, window.__submits || 0];`),
    ).toEqual(['blocked', 0]);
  });

  real('reports invalid when constraint validation fails', async () => {
    await load('<form><input id="q" pattern="[0-9]+"><button type="submit">Go</button></form>');
    expect(
      await run(`${SUBMIT_SPY}
                 const r = await f.input.performType({ selector: '#q', text: 'abc', instant: true, pressEnter: true });
                 return [r.enter, window.__submits || 0];`),
    ).toEqual(['invalid', 0]);
  });
});

describe('fox_type / fox_click targets', () => {
  real('performType without a locator types into the focused field', async () => {
    await load('<input id="a"><input id="b">');
    expect(
      await run(`document.getElementById('b').focus();
                 const r = await f.input.performType({ text: 'hi', instant: true });
                 return [r.element.id, document.getElementById('b').value, r.length];`),
    ).toEqual(['b', 'hi', 2]);
  });

  real('performType without a locator and without focus says what to pass', async () => {
    await load('<div>nothing to type into</div>');
    expect(
      await run(`return await f.input.performType({ text: 'hi' }).catch((e) => e.message);`),
    ).toContain('focus a field first');
  });

  real('disabled targets fail for click and for type', async () => {
    await load('<button id="b" disabled>Go</button><fieldset disabled><input id="i"></fieldset>');
    const [click, type] = await run<[string, string]>(
      `return [
         await f.input.performClick({ selector: '#b' }).catch((e) => e.message),
         await f.input.performType({ selector: '#i', text: 'hi' }).catch((e) => e.message),
       ];`,
    );
    expect(click).toContain('Element is disabled');
    expect(type).toContain('Element is disabled');
  });

  real('WP38 performType into a disabled focused field names it by tag / id / name', async () => {
    await load('<input id="i" name="n">');
    const message = await run<string>(
      `const el = document.getElementById('i');
       el.focus();
       el.setAttribute('aria-disabled', 'true');
       return await f.input.performType({ text: 'hi' }).catch((e) => e.message);`,
    );
    expect(message).toBe('Focused element is disabled: {"tag":"input","id":"i","name":"n"}');
  });

  real('WP38 pressKey finds its target by xpath, id and text like fox_click', async () => {
    await load('<input id="a"><input id="b"><button>Send</button><input id="c">');
    const r = await run<unknown[]>(
      `const seen = [];
       document.addEventListener('keydown', (e) => seen.push(e.target.id || e.target.tagName));
       document.getElementById('c').focus();
       const byXpath = await f.input.pressKey({ key: 'a', xpath: '//input[@id="a"]' });
       const byId = await f.input.pressKey({ key: 'a', id: 'b' });
       const byText = await f.input.pressKey({ key: 'a', text: 'Send' });
       const missing = await f.input.pressKey({ key: 'a', id: 'nope' }).catch((e) => e.message);
       return [byXpath.element.id, byId.element.id, byText.element.tag, seen, missing];`,
    );
    expect(r).toEqual(['a', 'b', 'button', ['a', 'b', 'BUTTON'], 'Element not found: {"id":"nope"}']);
  });

  real('selectOption fails for an option that is not there', async () => {
    await load('<select id="s"><option value="1">One</option></select>');
    const [unknown, ok] = await run<[string, Record<string, unknown>]>(
      `const miss = (() => { try { return f.input.selectOption({ selector: '#s', text: 'Two' }); }
                             catch (e) { return e.message; } })();
       return [miss, f.input.selectOption({ selector: '#s', text: 'One' })];`,
    );
    expect(unknown).toContain('No such option');
    expect(ok).toMatchObject({ selected: true, value: '1' });
  });
});

describe('waitForNetworkIdle', () => {
  real('times out with the pending fetch / XHR count', async () => {
    await load('<div>page</div>');
    const r = await run<Record<string, unknown>>(
      `const p = f.wait.waitForNetworkIdle({ timeout: 800, idleTime: 100 });
       window.fetch('/hang').catch(() => undefined);
       const xhr = new XMLHttpRequest();
       xhr.open('GET', '/hang?xhr');
       xhr.send();
       return await p;`,
    );
    expect(r).toMatchObject({
      success: false,
      idle: false,
      timedOut: true,
      pendingRequests: 2,
      waitedMs: 800,
      interception: { fetch: true, xhr: true },
    });
    expect(String(r['error'])).toContain('2 request(s) still in flight');
  });

  // D-safety-01: the counting hooks are there only while a wait runs.
  real('puts the page\'s own fetch and XMLHttpRequest.prototype.send back when the wait ends', async () => {
    await load('<div>page</div>');
    const r = await run<Record<string, unknown>>(
      `const fetch0 = window.fetch;
       const send0 = XMLHttpRequest.prototype.send;
       const p = f.wait.waitForNetworkIdle({ timeout: 3000, idleTime: 100 });
       const hooked = window.fetch !== fetch0 && XMLHttpRequest.prototype.send !== send0;
       await window.fetch('/?html=x');
       const result = await p;
       const restored = window.fetch === fetch0 && XMLHttpRequest.prototype.send === send0;
       const timedOut = await f.wait.waitForNetworkIdle({ timeout: 300, idleTime: 1000 });
       return {
         hooked, idle: result.idle, restored, timedOutIdle: timedOut.idle,
         restoredAfterTimeout: window.fetch === fetch0 && XMLHttpRequest.prototype.send === send0,
       };`,
    );
    expect(r).toEqual({ hooked: true, idle: true, restored: true, timedOutIdle: false, restoredAfterTimeout: true });
  });

  real('two waits at once share the hooks until the last one ends', async () => {
    await load('<div>page</div>');
    const r = await run<boolean[]>(
      `const fetch0 = window.fetch;
       const short = f.wait.waitForNetworkIdle({ timeout: 2000, idleTime: 50 });
       const long = f.wait.waitForNetworkIdle({ timeout: 2000, idleTime: 600 });
       await short;
       const keptForLong = window.fetch !== fetch0;
       await long;
       return [keptForLong, window.fetch === fetch0];`,
    );
    expect(r).toEqual([true, true]);
  });

  real('a fetch the page installed during the wait stays', async () => {
    await load('<div>page</div>');
    const kept = await run<boolean>(
      `const p = f.wait.waitForNetworkIdle({ timeout: 2000, idleTime: 100 });
       const pageOwn = function () { return Promise.resolve('page'); };
       window.fetch = pageOwn;
       await p;
       return window.fetch === pageOwn;`,
    );
    expect(kept).toBe(true);
  });
});

describe('element kinds in an XHTML document (tagName is lower case there)', () => {
  real('a password input of an XML document is still a password field', async () => {
    await load('<p></p>');
    const r = await run<{ tagName: string; password: boolean; textInput: boolean }>(
      `const xhtml = 'http://www.w3.org/1999/xhtml';
       const doc = document.implementation.createDocument(xhtml, 'html', null);
       const el = doc.createElementNS(xhtml, 'input');
       el.setAttribute('type', 'password');
       doc.documentElement.appendChild(el);
       return { tagName: el.tagName, password: f.dom.isPasswordField(el), textInput: f.dom.isTextInput(el) };`,
    );
    expect(r).toEqual({ tagName: 'input', password: true, textInput: true });
  });
});

// B-KM-02: the Extension's own masking and refusal, run in a page. A-KM-05:
// fox_read info's forms looked at type="password" only. B-KM-05: autocomplete
// is a case-insensitive token list.
describe('password fields on the extension path', () => {
  const FORM =
    '<form id="f">' +
    '<input id="p" type="password" value="pw-secret-1">' +
    '<input id="c" type="text" autocomplete="current-password" value="pw-secret-2">' +
    '<input id="t" type="text" autocomplete="section-login Current-Password webauthn" value="pw-secret-3">' +
    '<input id="u" type="text" autocomplete="username" value="user-1">' +
    '</form>';
  const MASKED_VIEW = { p: '[MASKED]', c: '[MASKED]', t: '[MASKED]', u: 'user-1' };
  type View = Record<string, unknown>;

  real('fox_read info, fox_find and get_value show [MASKED] for every password field', async () => {
    await load(FORM);
    const r = await run<{ interactive: View; forms: View; found: View; values: View }>(
      `const byId = (list) => Object.fromEntries(list.map((e) => [e.id, e.value]));
       const info = f.inspect.getPageInfo();
       return {
         interactive: byId(info.interactiveElements),
         forms: byId(info.forms[0].fields),
         found: byId(f.inspect.getElements({ selector: 'input' }).elements),
         values: Object.fromEntries(['p', 'c', 't', 'u'].map((id) => [id, f.inspect.getValue({ id }).value])),
       };`,
    );
    expect(r.interactive).toEqual(MASKED_VIEW);
    expect(r.forms).toEqual(MASKED_VIEW);
    expect(r.found).toEqual(MASKED_VIEW);
    expect(r.values).toEqual(MASKED_VIEW);
    expect(JSON.stringify(r)).not.toContain('pw-secret');
  });

  // Decision #4 / Fo-03: hidden, one-time code and payment card fields too
  // (rule: shared/src/field-mask.ts).
  real('fox_read info, fox_find and get_value mask hidden, one-time code and card fields', async () => {
    await load(
      '<form id="g">' +
      '<input id="h" type="hidden" value="secret-1">' +
      '<input id="o" type="text" autocomplete="one-time-code" value="secret-2">' +
      '<input id="n" type="text" autocomplete="cc-number" value="secret-3">' +
      '<input id="v" type="text" autocomplete="section-pay CC-CSC" value="secret-4">' +
      '<select id="m" autocomplete="cc-exp-month"><option value="secret-5" selected>05</option></select>' +
      '<input id="u" type="text" autocomplete="name" value="user-1">' +
      '</form>',
    );
    const r = await run<{ forms: View; values: View; found: View }>(
      `const byId = (list) => Object.fromEntries(list.map((e) => [e.id, e.value]));
       const ids = ['h', 'o', 'n', 'v', 'm', 'u'];
       return {
         forms: byId(f.inspect.getPageInfo().forms[0].fields),
         values: Object.fromEntries(ids.map((id) => [id, f.inspect.getValue({ id }).value])),
         found: byId(f.inspect.getElements({ selector: 'input, select' }).elements),
       };`,
    );
    const masked = { h: '[MASKED]', o: '[MASKED]', n: '[MASKED]', v: '[MASKED]', m: '[MASKED]', u: 'user-1' };
    expect(r.forms).toEqual(masked);
    expect(r.values).toEqual(masked);
    expect(r.found).toEqual(masked);
    expect(JSON.stringify(r)).not.toContain('secret');
  });

  real('fox_type and fox_set_value refuse every password field unless allowPassword', async () => {
    await load(FORM);
    const r = await run<Record<string, unknown>>(
      `const out = {};
       for (const id of ['p', 'c', 't']) {
         const typed = await f.input.performType({ id, text: 'x', instant: true })
           .then(() => 'typed', (e) => e.message);
         let set;
         try { f.input.setValue({ id, value: 'x' }); set = 'set'; } catch (e) { set = e.message; }
         out[id] = [typed, set, document.getElementById(id).value];
       }
       out.allowed = await f.input.performType({ id: 'c', text: 'x', instant: true, allowPassword: true })
         .then(() => 'typed', (e) => e.message);
       out.plain = f.input.setValue({ id: 'u', value: 'user-2' }).set;
       return out;`,
    );
    const refused = expect.stringContaining('Refused: target is a password field');
    expect(r['p']).toEqual([refused, refused, 'pw-secret-1']);
    expect(r['c']).toEqual([refused, refused, 'pw-secret-2']);
    expect(r['t']).toEqual([refused, refused, 'pw-secret-3']);
    expect(r['allowed']).toBe('typed');
    expect(r['plain']).toBe(true);
  });
});

describe('WP44 highlight and overlay banner timers (E-05, E-06, A-07)', () => {
  real('E-05 the timer of an earlier highlight does not remove the next one', async () => {
    await load('<div id="a">A</div><div id="b">B</div>');
    const r = await run<Record<string, number>>(
      // The overlay is the body's only child without an id; it carries no class.
      `const count = () => document.querySelectorAll('body > div:not([id]):not([class])').length;
       f.inspect.highlightElement({ selector: '#a', duration: 400 });
       await sleep(100);
       f.inspect.highlightElement({ selector: '#b', duration: 10000 });
       await sleep(500); // past the first highlight's 400 ms
       const second = count();
       f.inspect.highlightElement({ selector: '#a', duration: 150 });
       f.inspect.highlightElement({ selector: '#b', duration: 0 }); // stays
       await sleep(300);
       return { second, persistent: count() };`,
    );
    expect(r).toEqual({ second: 1, persistent: 1 });
  });

  real('E-06 a banner replaced by one with the same id settles at once; cancel reaches the new one', async () => {
    await load('<div>page</div>');
    const r = await run<Record<string, unknown>>(
      `const cfg = (title) => ({ id: 'b1', title, buttons: [{ label: 'x', value: 'done', color: '#fff' }],
                                 timeoutMs: 5000, borderColor: '#fff', background: '#000' });
       const state = { first: 'pending', second: 'pending' };
       f.overlay.createOverlayBanner(cfg('first')).then((v) => { state.first = v; });
       f.overlay.createOverlayBanner(cfg('second')).then((v) => { state.second = v; });
       await sleep(0);
       const afterReplace = { ...state, inDom: document.querySelectorAll('#b1').length };
       const closed = f.overlay.closeOverlayBanner('b1', 'timeout');
       await sleep(0);
       return { afterReplace, afterClose: { ...state, inDom: document.querySelectorAll('#b1').length },
                closed, again: f.overlay.closeOverlayBanner('b1', 'timeout') };`,
    );
    expect(r).toEqual({
      afterReplace: { first: 'superseded', second: 'pending', inDom: 1 },
      afterClose: { first: 'superseded', second: 'timeout', inDom: 0 },
      closed: true,
      again: false,
    });
  });

  real('E-06 a captcha solved by its token leaves no banner for cancelHumanWait', async () => {
    await load('<div class="g-recaptcha"></div>');
    const r = await run<Record<string, unknown>>(
      `const p = f.captcha.solveCaptcha({ timeout: 5000 });
       await sleep(50);
       const shown = !!document.getElementById('__fox_captcha_banner');
       const ta = document.createElement('textarea');
       ta.name = 'g-recaptcha-response'; ta.value = 'tok';
       document.body.appendChild(ta);
       const res = await p;
       return { shown, resolvedBy: res.resolvedBy,
                inDom: !!document.getElementById('__fox_captcha_banner'),
                cancel: f.overlay.cancelHumanWait() };`,
    );
    expect(r).toEqual({
      shown: true,
      resolvedBy: 'token',
      inDom: false,
      cancel: { success: true, cancelled: false },
    });
  });

  real('E-06 a second captcha wait in the tab ends the first one as superseded', async () => {
    await load('<div class="g-recaptcha"></div>');
    const r = await run<Record<string, unknown>[]>(
      `const first = f.captcha.solveCaptcha({ timeout: 5000 });
       await sleep(50);
       const second = f.captcha.solveCaptcha({ timeout: 5000 });
       const firstResult = await first;
       const cancel = f.overlay.cancelHumanWait();
       return [firstResult, await second, cancel];`,
    );
    expect(r[0]).toMatchObject({ solved: false, superseded: true });
    expect(r[0]).not.toHaveProperty('timedOut');
    // cancel_human_wait closes the newer wait (reported as a timeout).
    expect(r[1]).toMatchObject({ solved: false, timedOut: true });
    expect(r[2]).toEqual({ success: true, cancelled: true });
  });

  real('A-07 the captcha wait and cancel_human_wait use the same banner id (CAPTCHA_BANNER_ID)', async () => {
    await load('<div class="g-recaptcha"></div>');
    const r = await run<Record<string, unknown>>(
      `const id = ${JSON.stringify(CAPTCHA_BANNER_ID)};
       const p = f.captcha.solveCaptcha({ timeout: 5000 });
       await sleep(50);
       const shown = !!document.getElementById(id);
       const cancel = f.overlay.cancelHumanWait();
       const res = await p;
       return { shown, cancel, gone: !document.getElementById(id), timedOut: res.timedOut };`,
    );
    expect(r).toEqual({ shown: true, cancel: { success: true, cancelled: true }, gone: true, timedOut: true });
  });
});

describe('WP44 content input checks and truncation (E-12, E-13, E-17)', () => {
  // The cut itself (clipText in text-clip.ts) is tested once, in extension-background-async.test.ts.
  it('E-17 truncatedValue stringifies a value and keeps a missing one null', async () => {
    const dom = await import('../../packages/extension/src/content/dom.ts');
    expect(dom.truncatedValue(3, 10)).toBe('3');
    expect(dom.truncatedValue(12345, 3)).toBe('123');
    expect(dom.truncatedValue(undefined, 10)).toBeNull();
    expect(dom.truncatedValue(null, 10)).toBeNull();
  });

  real('E-17 getText and element info cut on character boundaries; numeric values do not fail', async () => {
    await load('<p id="p">ab\u{1F600}cd</p><ul><li id="li" value="3">x</li></ul>');
    const r = await run<Record<string, unknown>>(
      `const text = f.inspect.getText({ selector: '#p', maxLength: 3 });
       const li = f.dom.getElementInfo(document.getElementById('li'));
       return { text: text.text, truncated: text.truncated, liValue: li.value };`,
    );
    expect(r).toEqual({ text: 'ab', truncated: true, liValue: '3' });
  });

  real('E-12 performScroll fails for an unknown direction', async () => {
    await load('<div style="height:3000px">tall</div>');
    const r = await run<[string, Record<string, unknown>]>(
      `return [
         await f.input.performScroll({ direction: 'sideways' }).catch((e) => e.message),
         await f.input.performScroll({ direction: 'top' }),
       ];`,
    );
    expect(r[0]).toBe('Unknown scroll direction: "sideways" (expected up, down, left, right, top or bottom)');
    expect(r[1]).toMatchObject({ scrolled: true, position: { x: 0, y: 0 } });
  });

  // The Extension's scroll is the reference the headless backend follows
  // (R3 E-1 / E-2): these pin its behaviour, E-3 its result shape.
  real('fox_scroll: no direction, amount 0, and locators that match nothing', async () => {
    await load('<div id="box" style="height:100px;overflow:auto"><div style="height:1000px">in</div></div>' +
      '<div style="height:3000px">tall</div>');
    const r = await run<Record<string, Record<string, unknown>>>(
      `const reset = async () => { window.scrollTo(0, 0); await sleep(50); };
       const none = await f.input.performScroll({});
       const zero = await f.input.performScroll({ direction: 'down', amount: 0 });
       const missingSelector = await f.input.performScroll({ selector: '#nope', direction: 'down', amount: 200 });
       await reset();
       const missingTarget = await f.input.performScroll({ toElement: '#nope', direction: 'down', amount: 200 });
       await reset();
       const bottom = await f.input.performScroll({ selector: '#box', direction: 'bottom' });
       const top = await f.input.performScroll({ selector: '#box', direction: 'top' });
       return { none, zero, missingSelector, missingTarget, bottom, top };`,
    );
    // No direction: nothing moves, still scrolled: true (E-2).
    expect(r.none).toEqual({ scrolled: true, position: { x: 0, y: 0 } });
    // amount 0 is 0 pixels, not the 300 px default (E-3).
    expect(r.zero).toEqual({ scrolled: true, position: { x: 0, y: 0 } });
    // A selector that matches nothing scrolls the window; a toElement that
    // matches nothing falls through to the direction (E-1).
    expect(r.missingSelector).toMatchObject({ scrolled: true });
    expect((r.missingSelector.position as { y: number }).y).toBeGreaterThan(0);
    expect(r.missingTarget).not.toHaveProperty('element');
    expect((r.missingTarget.position as { y: number }).y).toBeGreaterThan(0);
    // top / bottom report the measured position like every other direction (E-3).
    expect((r.bottom.position as { y: number }).y).toBeGreaterThan(0);
    expect(r.top).toEqual({ scrolled: true, position: { x: 0, y: 0 } });
  });

  real('E-11 waitForChange changeType "text" sees a text change', async () => {
    await load('<p id="t">before</p>');
    const r = await run<Record<string, unknown>>(
      `const node = document.getElementById('t').firstChild;
       const p = f.wait.waitForChange({ selector: '#t', changeType: 'text', timeout: 2000 });
       setTimeout(() => { node.data = 'after'; }, 50);
       return await p;`,
    );
    expect(r).toMatchObject({ changed: true, changes: [{ type: 'characterData' }] });
  });

  real('E-13 waitForChange fails for a selector that matches nothing and for an unknown changeType', async () => {
    await load('<div id="t"></div>');
    const r = await run<[string, string, Record<string, unknown>]>(
      `const missing = await f.wait.waitForChange({ selector: '#nope', timeout: 500 }).catch((e) => e.message);
       const badType = await f.wait.waitForChange({ selector: '#t', changeType: 'bogus', timeout: 500 })
         .catch((e) => e.message);
       const p = f.wait.waitForChange({ selector: '#t', changeType: 'childList', timeout: 2000 });
       setTimeout(() => document.getElementById('t').appendChild(document.createElement('i')), 50);
       return [missing, badType, await p];`,
    );
    expect(r[0]).toBe('Element not found: #nope');
    expect(r[1]).toBe('Unknown changeType: "bogus" (expected childList, attributes or text)');
    expect(r[2]).toMatchObject({ changed: true });
  });
});
