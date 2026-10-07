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
 * launched.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { firefox, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAPTCHA_BANNER_ID } from '../../packages/extension/src/content/constants.ts';
import { readExtensionSource, readExtensionTree } from './helpers/extension-source.js';

interface ContentFns {
  escapeXPathString(s: string): string;
  textLocatorXPath(text: string): string | null;
  generateXPath(el: unknown): string;
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
    generateXPath: dom.generateXPath as ContentFns['generateXPath'],
    locatorOf: dom.locatorOf as unknown as ContentFns['locatorOf'],
    locatorWithoutText: dom.locatorWithoutText as unknown as ContentFns['locatorWithoutText'],
    typingDelay: input.typingDelay,
  };
});

// ---------------------------------------------------------------------------
// Real DOM harness (headless Firefox)
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The content modules, bundled like scripts/build-extension.mjs does. */
async function bundleSource(contents: string): Promise<string> {
  const out = await build({
    stdin: { contents, resolveDir: ROOT, sourcefile: 'entry.ts', loader: 'ts' },
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
import * as log from "./packages/extension/src/content/log-store";
import * as inspect from "./packages/extension/src/content/inspect";
import * as overlay from "./packages/extension/src/content/overlay";
import * as captcha from "./packages/extension/src/content/captcha";
(globalThis as Record<string, unknown>).__fox = { dom, input, wait, log, inspect, overlay, captcha };
`;

const CONTENT_ENTRY = `import "./packages/extension/src/content";`;

/** What the Firefox content-script sandbox gives the script, stubbed. */
const PRELUDE = `
window.__sent = [];
window.browser = {
  runtime: {
    sendMessage: (m) => { window.__sent.push(m); return Promise.resolve({ enabled: false }); },
    onMessage: { addListener: (fn) => { window.__listener = fn; } },
  },
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
let contentBundle = '';
let page: Page | null = null;
let available = false;

beforeAll(async () => {
  try {
    [libBundle, contentBundle] = await Promise.all([
      bundleSource(LIB_ENTRY),
      bundleSource(CONTENT_ENTRY),
    ]);
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
  } catch {
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
async function load(body: string, which: 'lib' | 'content' = 'lib'): Promise<void> {
  await page?.close();
  page = await context!.newPage();
  await page.goto(`${base}/?html=${encodeURIComponent(body)}`);
  await page.addScriptTag({ content: PRELUDE });
  await page.addScriptTag({ content: which === 'lib' ? libBundle : contentBundle });
}

/** Run `body` in the page; `f` is the bundle's modules, `sleep` a delay. */
async function run<T>(body: string): Promise<T> {
  return (await page!.evaluate(
    `(async () => {
       const f = window.__fox;
       const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
       const records = () => window.__sent.filter((m) => m.type === 'kitsune:logRecords');
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

describe('3.A11 generateXPath quotes ids as XPath literals', () => {
  it('uses concat() for ids with both quote kinds, never CSS escapes', () => {
    expect(fns.generateXPath({ id: `a"b'c` })).toBe(`//*[@id=concat('a"b', "'", 'c')]`);
    expect(fns.generateXPath({ id: 'x.y:1' })).toBe(`//*[@id='x.y:1']`);
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

describe('WP30 context menu "inspect element" uses the contextmenu target, not pageX / pageY', () => {
  it('remembers the element of the last contextmenu event while it is in the document', async () => {
    const inspect = await import('../../packages/extension/src/content/inspect.ts');
    const el = { nodeType: 1, isConnected: true };
    inspect.rememberContextTarget({ target: el as unknown as EventTarget });
    expect(inspect.contextTarget()).toBe(el);
    el.isConnected = false; // removed from the page meanwhile
    expect(inspect.contextTarget()).toBeNull();
    inspect.rememberContextTarget({ target: { nodeType: 9 } as unknown as EventTarget }); // document
    expect(inspect.contextTarget()).toBeNull();
  });

  it('content.ts records contextmenu targets; the menu sends no coordinates', () => {
    expect(readExtensionSource('content.ts'))
      .toMatch(/document\.addEventListener\("contextmenu", rememberContextTarget, true\)/);
    const menu = readExtensionSource('background/context-menu.ts');
    expect(menu).not.toMatch(/info\.page[XY]|page[XY]\?: number/);
    expect(menu).toMatch(/\{ action: "inspectElement" \}/);
    // WP38: nor does the contextMenus type declare them any more.
    expect(readExtensionSource('types/browser.d.ts')).not.toMatch(/page[XY]\?: number/);
  });
  // TODO(test): in a real Firefox: right-click an element (also in an
  //   iframe) → "inspect element" highlights that element.
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

describe('3.A11 generateXPath in a real DOM', () => {
  real('round-trips for HTML and for SVG (local-name) elements', async () => {
    await load('<div><p>one</p><p>two</p></div><svg width="10" height="10"><circle r="4"/></svg>');
    const found = await run<[string, boolean][]>(
      `return [document.querySelectorAll('p')[1], document.querySelector('circle')].map((el) => {
         const xpath = f.dom.generateXPath(el);
         const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
         return [xpath, node.singleNodeValue === el];
       });`,
    );
    expect(found.map(([, same]) => same)).toEqual([true, true]);
    expect(found[0]![0]).toBe('/html[1]/body[1]/div[1]/p[2]');
    expect(found[1]![0]).toContain(`*[local-name()='circle'][1]`);
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

describe('waits and observers', () => {
  real('waitForNetworkIdle times out with the pending request count', async () => {
    await load('<div>page</div>');
    const r = await run<Record<string, unknown>>(
      `f.log.ensurePageHooks();
       window.fetch('/hang').catch(() => undefined);
       return await f.wait.waitForNetworkIdle({ timeout: 800, idleTime: 100 });`,
    );
    expect(r).toMatchObject({
      success: false,
      idle: false,
      timedOut: true,
      pendingRequests: 1,
      waitedMs: 800,
      interception: { fetch: true, xhr: true },
    });
    expect(String(r['error'])).toContain('1 request(s) still in flight');
  });

  real('stopObserving returns the changes, and fails for an unknown id', async () => {
    await load('<div id="t"></div>');
    const [started, stopped, unknown] = await run<
      [Record<string, unknown>, Record<string, unknown>, string]
    >(
      `const started = f.wait.observeElement({ selector: '#t', observerId: 'o1' });
       document.getElementById('t').appendChild(document.createElement('span'));
       await sleep(50);
       const stopped = f.wait.stopObserving({ observerId: 'o1' });
       let unknown;
       try { f.wait.stopObserving({ observerId: 'nope' }); unknown = 'no error'; }
       catch (e) { unknown = e.message; }
       return [started, stopped, unknown];`,
    );
    expect(started).toMatchObject({ observing: true, observerId: 'o1', target: '#t' });
    expect(stopped).toMatchObject({ stopped: true, observerId: 'o1', totalChanges: 1 });
    expect(unknown).toContain("No observer 'nope' on this page");
  });

  real('inject_observer flags select what is observed', async () => {
    await load('<div id="t"><span>x</span></div>');
    const [all, childListOnly] = await run<[Record<string, unknown>[], Record<string, unknown>[]]>(
      `const mutate = () => {
         document.getElementById('t').setAttribute('data-n', '1');
         document.getElementById('t').appendChild(document.createElement('b'));
       };
       f.wait.observeElement({ selector: '#t', observerId: 'all' });
       f.wait.observeElement({ selector: '#t', observerId: 'kids', observeAttributes: false, observeSubtree: false });
       mutate();
       await sleep(50);
       return [
         f.wait.stopObserving({ observerId: 'all' }).changes,
         f.wait.stopObserving({ observerId: 'kids' }).changes,
       ];`,
    );
    expect(all.map((c) => c['type'])).toEqual(['attributes', 'childList']);
    expect(all[0]).toMatchObject({ attributeName: 'data-n', target: '#t', oldValue: null });
    // observeAttributes: false keeps the attribute change out.
    expect(childListOnly.map((c) => c['type'])).toEqual(['childList']);
    expect(childListOnly[0]).toMatchObject({ addedNodes: ['b'] });
  });
});

describe('content-side log batching', () => {
  real('a timer hands the recorded entries to the background', async () => {
    await load('<div>page</div>');
    const sent = await run<Record<string, unknown>[]>(
      `f.log.startLogging({});
       console.log('hello', { a: 1 });
       await sleep(600);
       return records();`,
    );
    expect(sent).toHaveLength(1);
    const entries = sent[0]!['console'] as Record<string, unknown>[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: 'log' });
    expect(String(entries[0]!['message'])).toContain('hello');
  });

  real('flushLogs and stopLogging hand the pending entries over once', async () => {
    await load('<div>page</div>');
    const r = await run<Record<string, number>>(
      `f.log.startLogging({});
       console.log('one');
       const a = f.log.flushLogs();
       const b = f.log.flushLogs();
       console.log('two');
       const c = f.log.stopLogging();
       console.log('after stop');
       const d = f.log.stopLogging();
       await sleep(600);
       return { a: a.console.length, b: b.console.length, c: c.console.length,
                d: d.console.length, sent: records().length, logging: a.loggingEnabled };`,
    );
    // Each entry is handed over once, and the pending timer is cancelled
    // with it (nothing reaches the background afterwards).
    expect(r).toEqual({ a: 1, b: 0, c: 1, d: 0, sent: 0, logging: true });
  });

  real('WP38 a batch refused for a protected page drops what is still pending', async () => {
    await load('<div>page</div>');
    const r = await run<Record<string, number>>(
      `let answer;
       window.browser.runtime.sendMessage = (m) => {
         window.__sent.push(m);
         return new Promise((resolve) => { answer = resolve; });
       };
       f.log.startLogging({});
       console.log('one');
       await sleep(400);
       console.log('two');
       answer({ accepted: false, reason: 'protected_page' });
       await sleep(0);
       const pending = f.log.flushLogs().console.length;
       await sleep(400);
       return { pending, sent: records().length };`,
    );
    // 'one' went in the refused batch; 'two' is dropped, and its timer with it.
    expect(r).toEqual({ pending: 0, sent: 1 });
  });

  real('WP38 clearLogs cancels the batch timer once nothing is pending', async () => {
    await load('<div>page</div>');
    const r = await run<boolean[]>(
      `const set = window.setTimeout, clear = window.clearTimeout;
       const timers = []; const cleared = [];
       window.setTimeout = (fn, ms) => { const id = set(fn, ms); if (ms === 250) timers.push(id); return id; };
       window.clearTimeout = (id) => { cleared.push(id); return clear(id); };
       try {
         f.log.startLogging({});
         console.log('a');
         f.log.clearLogs({ console: false });
         const keptWhilePending = !cleared.includes(timers[0]);
         f.log.clearLogs({});
         return [keptWhilePending, cleared.includes(timers[0])];
       } finally {
         window.setTimeout = set;
         window.clearTimeout = clear;
       }`,
    );
    expect(r).toEqual([true, true]);
  });

  real('pagehide hands over what is pending, with the injection flags', async () => {
    await load('<div>page</div>', 'content');
    const r = await run<Record<string, unknown>>(
      `const send = (msg) => new Promise((resolve) => { window.__listener(msg, {}, resolve); });
       await send({ action: 'startLogging' });
       console.log('bye');
       window.dispatchEvent(new Event('pagehide'));
       const flush = await send({ action: 'flushLogs' });
       return { sent: records(), flush };`,
    );
    const sent = r['sent'] as Record<string, unknown>[];
    expect(sent).toHaveLength(1);
    expect((sent[0]!['console'] as Record<string, unknown>[])[0]).toMatchObject({ level: 'log' });
    // Nothing was left pending, and the hook / injection flags are reported.
    expect(r['flush']).toMatchObject({
      success: true,
      console: [],
      loggingEnabled: true,
      interception: { fetch: true, xhr: true, console: true },
      injection: { readyStateAtInit: 'complete', readyStateAtHookInstall: 'complete' },
    });
  });
});

describe('WP44 highlight and overlay banner timers (E-05, E-06, A-07)', () => {
  real('E-05 the timer of an earlier highlight does not remove the next one', async () => {
    await load('<div id="a">A</div><div id="b">B</div>');
    const r = await run<Record<string, number>>(
      `const count = () => document.querySelectorAll('.kitsune-highlight-overlay').length;
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

describe('WP44 content input checks, observer ids, XHR log and truncation (E-12, E-13, A-06, E-15, E-17)', () => {
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

  real('A-06 generated observer ids do not repeat within a millisecond', async () => {
    await load('<div id="t"></div>');
    const r = await run<Record<string, unknown>>(
      `const now = Date.now;
       Date.now = () => 1000; // every call in the same millisecond
       let a, b;
       try {
         a = f.wait.observeElement({ selector: '#t' }).observerId;
         b = f.wait.observeElement({ selector: '#t' }).observerId;
       } finally { Date.now = now; }
       document.getElementById('t').appendChild(document.createElement('span'));
       await sleep(50);
       return { distinct: a !== b, a: f.wait.stopObserving({ observerId: a }).totalChanges,
                b: f.wait.stopObserving({ observerId: b }).totalChanges };`,
    );
    expect(r).toEqual({ distinct: true, a: 1, b: 1 });
  });

  real('E-15 the network log records aborted and timed-out XHR requests', async () => {
    await load('<div>page</div>');
    const r = await run<Record<string, unknown>[]>(
      `f.log.startLogging({});
       const aborted = new XMLHttpRequest();
       aborted.open('GET', '/hang?aborted');
       aborted.send();
       const late = new XMLHttpRequest();
       late.open('GET', '/hang?timeout');
       late.timeout = 200;
       late.send();
       await sleep(50);
       aborted.abort();
       await sleep(400);
       const sent = records().flatMap((m) => m.network || []);
       return [...sent, ...(f.log.flushLogs().network || [])]
         .map((e) => ({ url: e.url, error: e.error }));`,
    );
    expect(r).toEqual(
      expect.arrayContaining([
        { url: '/hang?aborted', error: 'Aborted' },
        { url: '/hang?timeout', error: 'Timeout' },
      ]),
    );
    expect(r).toHaveLength(2);
  });
});
