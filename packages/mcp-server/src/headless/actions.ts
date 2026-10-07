/**
 * Routing table of the headless backend: what HeadlessBrowser.execute() does
 * with each BrowserCommand action, and the handlers of the actions it runs.
 *
 * Each handler reads its arguments through a schema of its own (parseArgs):
 * what the tool schema (tools/schemas.ts) requires or fills in with a
 * default is required here, so no default is repeated in this file.
 *
 * Only playwright types are imported here (see headless-lifecycle.test.ts).
 */

import type { BrowserContext, ConsoleMessage, ElementHandle, Page } from 'playwright';
import { z } from 'zod';
import { BrowserActionSchema, isRecord, type BrowserAction } from '@kitsune-mcp/shared';
import { countOccurrences, filterAriaSnapshot, parseArgs } from './helpers.js';
import { isPasswordElement, PASSWORD_REFUSAL } from '../safety/password-guard.js';
import { focusedIsPassword } from './focus.js';
import { getScreenshotsDir } from '../utils/screenshot.js';
import { SCROLL_DIRECTIONS } from '../tools/schemas.js';
import {
  AVAILABLE_OPTIONS_MAX,
  ELEMENT_TEXT_MAX_CHARS,
  ELEMENT_TIMEOUT_MS,
  GET_ELEMENTS_MAX,
  HIGHLIGHT_OUTLINE,
  HISTORY_TIMEOUT_MS,
  NAVIGATE_TIMEOUT_MS,
  SCRIPT_TIMEOUT_MS,
  SELECT_OPTION_TIMEOUT_MS,
  SNAPSHOT_MAX_CHARS,
  WAIT_AND_ACT_DEFAULT_MS,
  WAIT_AND_ACT_POLL_MIN_MS,
  WAIT_AND_ACT_POLL_MS,
} from './limits.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Captcha detection JS — mirrors the extension's content-script heuristics
// ---------------------------------------------------------------------------

const CAPTCHA_DETECT_JS = `(function() {
  const widgets = [];
  const tokened = (name) => {
    const el = document.querySelector('textarea[name="'+name+'"], input[name="'+name+'"]');
    return !!(el && el.value && el.value.length > 0);
  };
  if (document.querySelector('.g-recaptcha, iframe[src*="recaptcha"], #g-recaptcha-response'))
    widgets.push({type:'recaptcha', solved: tokened('g-recaptcha-response') || !!document.querySelector('.recaptcha-checkbox-checked')});
  if (document.querySelector('.h-captcha, iframe[src*="hcaptcha"], textarea[name="h-captcha-response"]'))
    widgets.push({type:'hcaptcha', solved: tokened('h-captcha-response')});
  if (document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"], input[name="cf-turnstile-response"]'))
    widgets.push({type:'turnstile', solved: tokened('cf-turnstile-response')});
  if (widgets.length === 0 &&
      document.querySelector('img[src*="captcha" i], input[name*="captcha" i], [id*="captcha" i], [class*="captcha" i]'))
    widgets.push({type:'generic', solved: null});
  return {present: widgets.length > 0, widgets: widgets};
})()`;

// ---------------------------------------------------------------------------
// Table types
// ---------------------------------------------------------------------------

/** The tab state of HeadlessBrowser that handlers read or change. */
export interface TabHost {
  /** The browser context (execute() runs no handler before start()). */
  context(): BrowserContext;
  activeTabId(): number | null;
  tabs(): ReadonlyMap<number, Page>;
  /** Register `page` as a new tab and make it the active one; returns its id. */
  adoptTab(page: Page): number;
  /** Make the open tab `tabId`, whose page is `page`, the active one. */
  activateTab(tabId: number, page: Page): void;
}

interface ContextBase {
  tabId: number | undefined;
  args: Record<string, unknown>;
  host: TabHost;
  /** Date.now() at which the caller stops waiting (Infinity: no deadline). */
  deadline: number;
  /** Aborted when the caller gave up on the command. */
  signal: AbortSignal | undefined;
}

interface ActionContext extends ContextBase {
  /** The page of `tabId`, or the active page when no tabId was given. */
  page: Page;
}

interface TablessContext extends ContextBase {
  /** As in ActionContext; null when no tabId was given and no tab is open. */
  page: Page | null;
}

type Result = Record<string, unknown>;
type ActionHandler = (c: ActionContext) => Promise<Result>;
type TablessHandler = (c: TablessContext) => Promise<Result>;

/**
 * - dispatch: run under execute()'s lock. With needsPage, on the page of the
 *   target tab, and the result names that tab (url, tabId); without, also
 *   when no tab is open (tab list, new tabs).
 * - unlocked: execute() runs it itself outside the lock (handle_dialog: it
 *   waits for a dialog that a queued action may be about to open)
 * - unsupported: answered with "Unsupported headless action" (after the
 *   target tab was resolved, like a dispatch action)
 */
type HeadlessRoute =
  | { kind: 'dispatch'; needsPage: true; run: ActionHandler }
  | { kind: 'dispatch'; needsPage: false; run: TablessHandler }
  | { kind: 'unlocked' }
  | { kind: 'unsupported' };

/** The error of an action on "the active tab" while no tab is open (the last one was closed). */
export const NO_TAB_ERROR =
  "No headless tab is open: open one with fox_tab action 'create' or fox_navigate with newTab: true";

// ---------------------------------------------------------------------------
// Bounded page scripts
// ---------------------------------------------------------------------------

/** What bounds a wait: a deadline (Date.now() value) and an optional abort. */
interface Bound {
  deadline: number;
  signal: AbortSignal | undefined;
}

/**
 * `work` (a page.evaluate(), which has no timeout of its own), given up
 * after `ms`, at `bound.deadline` or when `bound.signal` aborts, whichever
 * comes first. Giving up does not stop the script in the page; it frees
 * execute()'s lock for the next command.
 */
function bounded<T>(work: Promise<T>, bound: Bound, ms: number, what: string): Promise<T> {
  const limit = Math.max(0, Math.min(ms, bound.deadline - Date.now()));
  work.catch(() => { /* the loser of the race below */ });
  return new Promise<T>((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer);
      bound.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      done();
      reject(new Error(`${what} was cancelled: the caller gave up`));
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error(`${what} did not finish within ${limit} ms`));
    }, limit);
    if (bound.signal?.aborted === true) {
      onAbort();
      return;
    }
    bound.signal?.addEventListener('abort', onAbort, { once: true });
    work.then((v) => { done(); resolve(v); }, (e: unknown) => { done(); reject(e); });
  });
}

/** page.evaluate(script), bounded by SCRIPT_TIMEOUT_MS and `bound`. */
function evaluateScript(page: Page, script: string, bound: Bound, what = 'The script'): Promise<unknown> {
  return bounded(page.evaluate(script), bound, SCRIPT_TIMEOUT_MS, what);
}

// ---------------------------------------------------------------------------
// Password guard
// ---------------------------------------------------------------------------

/** get_value's answer for a password field, as on the Extension (content/inspect.ts getValue). */
const PASSWORD_VALUE_MASK = '[MASKED]';

/**
 * Password guard: refuse a password field unless the command carries
 * allowPassword: true (set by handlers.ts from safety.json, see
 * safety/password-guard.ts).
 */
function refusePassword(isPassword: boolean, args: Record<string, unknown>): void {
  if (isPassword && args['allowPassword'] !== true) {
    throw new Error(PASSWORD_REFUSAL);
  }
}

/**
 * The element `selector` resolves to, after the password guard. Resolved
 * once (waiting like page.fill() would), so the element checked is the
 * element then written to.
 */
async function guardedTarget(
  page: Page,
  selector: string,
  args: Record<string, unknown>,
): Promise<ElementHandle> {
  const target = await page.waitForSelector(selector, { state: 'attached', timeout: ELEMENT_TIMEOUT_MS });
  refusePassword(await target.evaluate(isPasswordElement), args);
  return target;
}

/**
 * The text a fill of `el` would extend: the value of an input / textarea
 * (of the control of a <label>, which fill() fills), the text of an editable
 * element; '' for anything else. Self-contained (runs in the page).
 */
function currentText(el: Element): string {
  const target = el instanceof HTMLLabelElement ? el.control : el;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return target.value;
  if (target instanceof HTMLElement && target.isContentEditable) return target.textContent ?? '';
  return '';
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const selectorArgs = z.object({ selector: z.string() });
const timeoutArgs = z.object({ timeout: z.number() });

// --- navigation ---
const navigateArgs = z.object({ url: z.string().optional(), newTab: z.boolean() });

const navigate: TablessHandler = async ({ page, tabId, args, host }) => {
  const { url, newTab } = parseArgs(navigateArgs, args, 'navigate');
  if (!url) return { success: false, error: 'navigate requires url' };
  let target: Page;
  let targetId: number | null;
  if (newTab) {
    target = await host.context().newPage();
    targetId = host.adoptTab(target);
  } else if (page !== null) {
    target = page;
    targetId = tabId ?? host.activeTabId();
  } else {
    return { success: false, error: NO_TAB_ERROR };
  }
  await target.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATE_TIMEOUT_MS });
  return {
    success: true,
    url: target.url(),
    title: await target.title(),
    ...(targetId !== null ? { tabId: targetId } : {}),
  };
};

// --- screenshot (file) ---
/** fullPage is set by handlers.ts for scope full_page only. */
const screenshotArgs = z.object({ filename: z.string().optional(), fullPage: z.boolean().optional() });

const screenshot: ActionHandler = async ({ page, args }) => {
  const { filename: requested, fullPage } = parseArgs(screenshotArgs, args, 'screenshot');
  const dir = getScreenshotsDir();
  fs.mkdirSync(dir, { recursive: true });
  const filename = path.basename(requested || `screenshot_${Date.now()}.png`);
  const filepath = path.join(dir, filename);
  await page.screenshot({ path: filepath, fullPage: fullPage === true });
  const stats = fs.statSync(filepath);
  // Same shape as the Extension path (Native Host): data.imagePath
  return {
    success: true,
    imagePath: filepath,
    url: page.url(),
    filename,
    size: stats.size,
    message: `Screenshot saved to ${filepath}`,
  };
};

// --- snapshot (accessibility tree as text; images are fox_screenshot's job) ---
const snapshotArgs = z.object({
  selector: z.string().optional(),
  maxDepth: z.number().optional(),
  includeText: z.boolean(),
  roles: z.array(z.string()).optional(),
});

const snapshot: ActionHandler = async ({ page, args }) => {
  const { selector, maxDepth, includeText, roles } = parseArgs(snapshotArgs, args, 'snapshot');
  const sel = selector || 'body';
  const loc = page.locator(sel);
  const matches = await loc.count();
  if (matches === 0) return { success: false, error: `No element matches selector: ${sel}` };
  const raw = await loc.first().ariaSnapshot({ timeout: ELEMENT_TIMEOUT_MS });
  const text = filterAriaSnapshot(raw, { maxDepth, includeText, roles });
  return {
    success: true,
    url: page.url(),
    title: await page.title(),
    format: 'aria-yaml',
    snapshot: text.slice(0, SNAPSHOT_MAX_CHARS),
    truncated: text.length > SNAPSHOT_MAX_CHARS,
    totalLength: text.length,
    ...(matches > 1 ? { warnings: [`selector matched ${matches} elements; only the first is shown`] } : {}),
  };
};

// --- click ---
const clickArgs = z.object({
  selector: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});

const click: ActionHandler = async ({ page, args }) => {
  const { selector, x, y } = parseArgs(clickArgs, args, 'click');
  if (selector) {
    await page.click(selector, { timeout: ELEMENT_TIMEOUT_MS });
  } else if (x !== undefined && y !== undefined) {
    await page.mouse.click(x, y);
  } else {
    return {
      success: false,
      error: 'click requires selector or x+y in headless mode (xpath and text are not supported)',
    };
  }
  return { success: true };
};

// --- type ---
const typeArgs = z.object({ text: z.string(), selector: z.string().optional(), clear: z.boolean() });

const type: ActionHandler = async ({ page, args }) => {
  const { text, selector, clear } = parseArgs(typeArgs, args, 'type');
  if (selector) {
    // As on the Extension: appended to the current content unless clear.
    const target = await guardedTarget(page, selector, args);
    const current = clear ? '' : await target.evaluate(currentText);
    await target.fill(current + text, { timeout: ELEMENT_TIMEOUT_MS });
  } else {
    // Keyboard input goes to the focused element.
    refusePassword(await focusedIsPassword(page.mainFrame()), args);
    await page.keyboard.type(text);
  }
  return { success: true };
};

// --- scroll ---
// As on the Extension (content/input.ts performScroll): toElement first; when
// it matches nothing, direction applies; a selector that matches nothing
// scrolls the window; without toElement and direction nothing moves.
type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number];

/** An unknown direction fails the parse (it used to be ignored: nothing moved). */
const scrollArgs = z.object({
  toElement: z.string().optional(),
  direction: z.enum(SCROLL_DIRECTIONS).optional(),
  amount: z.number(),
  selector: z.string().optional(),
});

interface ScrollPosition { x: number; y: number }

interface ScrolledTo {
  element: { tag: string; text: string; box: { x: number; y: number; width: number; height: number } };
  position: ScrollPosition;
}

/** Bring the element `toElement` into view; null when nothing matches. */
function scrollToElement(page: Page, toElement: string): Promise<ScrolledTo | null> {
  return page.evaluate(({ sel, maxText }) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return {
      element: {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? '').trim().slice(0, maxText),
        box: { x: r.x, y: r.y, width: r.width, height: r.height },
      },
      position: { x: window.scrollX, y: window.scrollY },
    };
  }, { sel: toElement, maxText: ELEMENT_TEXT_MAX_CHARS });
}

interface ScrolledBy {
  /** Whether `selector` matched (false also without a selector: the window). */
  found: boolean;
  scrolled: boolean;
  position: ScrollPosition;
}

/**
 * Scroll the element `selector` (the window when null or when it matches
 * nothing) in `direction`; with direction null nothing moves (the position
 * is read only).
 */
function scrollBy(page: Page, selector: string | null, direction: ScrollDirection | null, amount: number): Promise<ScrolledBy> {
  return page.evaluate(({ sel, dir, amt }) => {
    const el = sel ? document.querySelector(sel) : null;
    const doc = document.scrollingElement ?? document.documentElement;
    const pos = (): { x: number; y: number } =>
      el ? { x: el.scrollLeft, y: el.scrollTop } : { x: window.scrollX, y: window.scrollY };
    const by = (x: number, y: number): void => {
      const opts: ScrollToOptions = { left: x, top: y, behavior: 'instant' };
      if (el) el.scrollBy(opts); else window.scrollBy(opts);
    };
    const to = (y: number): void => {
      const opts: ScrollToOptions = { top: y, behavior: 'instant' };
      if (el) el.scrollTo(opts); else window.scrollTo(opts);
    };
    const before = pos();
    if (dir === 'up') by(0, -amt);
    else if (dir === 'down') by(0, amt);
    else if (dir === 'left') by(-amt, 0);
    else if (dir === 'right') by(amt, 0);
    else if (dir === 'top') to(0);
    else if (dir === 'bottom') to(el ? el.scrollHeight : doc.scrollHeight);
    const after = pos();
    return { found: el !== null, scrolled: before.x !== after.x || before.y !== after.y, position: after };
  }, { sel: selector, dir: direction, amt: Math.abs(amount) });
}

const scroll: ActionHandler = async ({ page, args }) => {
  const { toElement, direction, amount, selector } = parseArgs(scrollArgs, args, 'scroll');
  const warnings: string[] = [];
  if (toElement) {
    const found = await scrollToElement(page, toElement);
    if (found) return { success: true, scrolled: true, ...found, url: page.url() };
    warnings.push(`toElement matched no element, it was skipped: ${toElement}`);
  }
  const moved = await scrollBy(page, selector ?? null, direction ?? null, amount);
  if (selector && !moved.found) warnings.push(`selector matched no element, the window was used: ${selector}`);
  const warned = warnings.length > 0 ? { warnings } : {};
  if (direction === undefined) {
    // Nothing to do: scrolled: true as on the Extension.
    return { success: true, scrolled: true, position: moved.position, url: page.url(), ...warned };
  }
  return {
    success: true,
    scrolled: moved.scrolled,
    position: moved.position,
    target: moved.found ? 'element' : 'window',
    direction,
    url: page.url(),
    ...warned,
  };
};

// --- hover ---
const hover: ActionHandler = async ({ page, args }) => {
  const { selector } = parseArgs(selectorArgs, args, 'hover');
  await page.hover(selector, { timeout: ELEMENT_TIMEOUT_MS });
  return { success: true };
};

// --- refresh ---
const refresh: ActionHandler = async ({ page }) => {
  await page.reload({ timeout: NAVIGATE_TIMEOUT_MS });
  return { success: true };
};

// --- highlight ---
const highlightArgs = selectorArgs.extend({ duration: z.number() });

const highlight: ActionHandler = async ({ page, args }) => {
  const { selector, duration } = parseArgs(highlightArgs, args, 'highlight');
  await page.$eval(
    selector,
    (el, { ms, outline }) => {
      if (!(el instanceof HTMLElement || el instanceof SVGElement)) {
        throw new Error('The element has no style to draw an outline with');
      }
      el.style.outline = outline;
      setTimeout(() => { el.style.outline = ''; }, ms);
    },
    { ms: duration, outline: HIGHLIGHT_OUTLINE },
  );
  return { success: true };
};

// --- get_page_info ---
const getPageInfo: ActionHandler = async ({ page }) => {
  return { success: true, url: page.url(), title: await page.title() };
};

// --- get_elements ---
const getElementsArgs = selectorArgs.extend({ limit: z.number() });

const getElements: ActionHandler = async ({ page, args }) => {
  const { selector, limit } = parseArgs(getElementsArgs, args, 'get_elements');
  // One round trip; `count` is every match, as on the Extension (content/inspect.ts getElements).
  const found = await page.$$eval(
    selector,
    (els, { max, maxText }) => ({
      count: els.length,
      elements: els.slice(0, max).map((e) => {
        const r = e.getBoundingClientRect();
        return {
          tag: e.tagName.toLowerCase(),
          text: (e instanceof HTMLElement ? e.innerText : e.textContent ?? '').slice(0, maxText),
          // null for an element without a box (display: none), as boundingBox() answered.
          box: e.getClientRects().length === 0 ? null : { x: r.x, y: r.y, width: r.width, height: r.height },
        };
      }),
    }),
    { max: Math.max(0, Math.min(limit, GET_ELEMENTS_MAX)), maxText: ELEMENT_TEXT_MAX_CHARS },
  );
  return { success: true, elements: found.elements, count: found.count };
};

// --- execute_script ---
const scriptArgs = z.object({ script: z.string() });

const executeScript: ActionHandler = async (c) => {
  const { script } = parseArgs(scriptArgs, c.args, 'execute_script');
  const result = await evaluateScript(c.page, script, c);
  return { success: true, result };
};

// --- wait_for_element ---
const waitForElementArgs = selectorArgs.merge(timeoutArgs).extend({ visible: z.boolean() });

const waitForElement: ActionHandler = async ({ page, args }) => {
  const { selector, timeout, visible } = parseArgs(waitForElementArgs, args, 'wait_for_element');
  await page.waitForSelector(selector, { timeout, state: visible ? 'visible' : 'attached' });
  return { success: true };
};

// --- wait_for_network_idle ---
const waitForNetworkIdle: ActionHandler = async ({ page, args }) => {
  const { timeout } = parseArgs(timeoutArgs, args, 'wait_for_network_idle');
  await page.waitForLoadState('networkidle', { timeout });
  return { success: true };
};

// --- get_tabs ---
const getTabs: TablessHandler = async ({ host }) => {
  const tabs: Record<string, unknown>[] = [];
  const activeTabId = host.activeTabId();
  for (const [tid, p] of host.tabs()) {
    try {
      tabs.push({
        id: tid,
        url: p.url(),
        title: await p.title(),
        active: tid === activeTabId,
      });
    } catch {
      // page closed between iteration
    }
  }
  return { success: true, tabs, totalTabs: tabs.length };
};

// --- create_tab ---
const BLANK_URL = 'about:blank';
const createTabArgs = z.object({ url: z.string() });

const createTab: TablessHandler = async ({ args, host }) => {
  const { url } = parseArgs(createTabArgs, args, 'create_tab');
  const newPage = await host.context().newPage();
  if (url !== BLANK_URL) {
    try {
      await newPage.goto(url, { timeout: NAVIGATE_TIMEOUT_MS });
    } catch (e) {
      // Not registered yet: close it, or it stays open where no tab command reaches it.
      await newPage.close().catch(() => { /* the goto error is the one to report */ });
      throw e;
    }
  }
  const newId = host.adoptTab(newPage);
  return { success: true, tabId: newId, url: newPage.url() };
};

// --- close_tab ---
// The tool schemas require tabId; execute() has already refused an unknown
// one. A direct execute() call without one is refused as on the Extension
// (needsTabId), rather than closing the active tab.
const closeTab: ActionHandler = async ({ page, tabId }) => {
  if (tabId === undefined) return { success: false, error: 'close_tab requires tabId' };
  await page.close();
  // `closed` as on the Extension; closedTabId kept for older readers.
  return { success: true, closed: tabId, closedTabId: tabId };
};

// --- focus_tab ---
// As close_tab; execute() adds the tab's id and URL to the result.
const focusTab: ActionHandler = async ({ page, tabId, host }) => {
  if (tabId !== undefined) host.activateTab(tabId, page);
  await page.bringToFront();
  return { success: true };
};

// --- get_value ---
const getValue: ActionHandler = async ({ page, args }) => {
  const { selector } = parseArgs(selectorArgs, args, 'get_value');
  const el = await page.$(selector);
  if (el === null) return { success: false, error: `No element matches selector: ${selector}` };
  // As on the Extension (content/inspect.ts getValue): a <label> is read as
  // itself (its text), not as its control.
  const label = await el.evaluate((e) => e instanceof HTMLLabelElement);
  if (!label && await el.evaluate(isPasswordElement)) return { success: true, value: PASSWORD_VALUE_MASK };
  const value = await el.evaluate((e): string | null => {
    if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) return e.value;
    if (e instanceof HTMLSelectElement) return e.options[e.selectedIndex]?.value ?? null;
    return e.textContent;
  });
  return { success: true, value };
};

// --- set_value ---
const setValueArgs = z.object({ selector: z.string(), value: z.string() });

const setValue: ActionHandler = async ({ page, args }) => {
  const { selector, value } = parseArgs(setValueArgs, args, 'set_value');
  const target = await guardedTarget(page, selector, args);
  // A <select> as on the Extension (fill() refuses it): value set, then
  // input and change; like there, an unknown value selects nothing.
  const onSelect = await target.evaluate((el, v) => {
    if (!(el instanceof HTMLSelectElement)) return false;
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, value);
  if (!onSelect) await target.fill(value, { timeout: ELEMENT_TIMEOUT_MS });
  return { success: true };
};

// --- select_option ---
const selectOptionArgs = z.object({
  selector: z.string(),
  value: z.string().optional(),
  index: z.number().optional(),
  text: z.string().optional(),
});

const selectOption: ActionHandler = async ({ page, args }) => {
  const { selector, ...want } = parseArgs(selectOptionArgs, args, 'select_option');
  if (want.value === undefined && want.index === undefined && want.text === undefined) {
    return { success: false, error: 'select_option requires value, text, or index' };
  }
  // Look the option up first (value, then index, then exact text, then
  // trimmed text, as the extension does): selectOption() alone reports a
  // miss as success. One locator for both steps, so the element looked up
  // is the element selected.
  const target = page.locator(selector).first();
  const info = await target.evaluate(
    (el, w) => {
      if (!(el instanceof HTMLSelectElement)) return { kind: 'not-select' as const };
      const options = Array.from(el.options).map((o) => ({ value: o.value, text: o.text }));
      let idx = -1;
      if (w.value !== undefined) idx = options.findIndex((o) => o.value === w.value);
      else if (w.index !== undefined) idx = w.index >= 0 && w.index < options.length ? w.index : -1;
      else if (w.text !== undefined) {
        const text = w.text;
        idx = options.findIndex((o) => o.text === text);
        if (idx < 0) idx = options.findIndex((o) => o.text.trim() === text.trim());
      }
      return { kind: 'ok' as const, idx, options };
    },
    want,
    { timeout: SELECT_OPTION_TIMEOUT_MS },
  );
  if (info.kind === 'not-select') {
    return { success: false, error: `Element is not a <select>: ${selector}` };
  }
  const picked = info.idx < 0 ? undefined : info.options[info.idx];
  if (picked === undefined) {
    const what = want.value !== undefined ? `value "${want.value}"`
      : want.index !== undefined ? `index ${want.index}` : `text "${want.text}"`;
    return {
      success: false,
      error: `No option matches ${what}`,
      availableOptions: info.options.slice(0, AVAILABLE_OPTIONS_MAX),
    };
  }
  const chosen = await target.selectOption({ index: info.idx }, { timeout: SELECT_OPTION_TIMEOUT_MS });
  if (chosen.length === 0) {
    return { success: false, error: `Option was not selected: ${selector}` };
  }
  return { success: true, selected: true, value: picked.value, text: picked.text };
};

// --- go_back ---
const goBack: ActionHandler = async ({ page }) => {
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: HISTORY_TIMEOUT_MS });
  return { success: true, url: page.url(), title: await page.title() };
};

// --- go_forward ---
const goForward: ActionHandler = async ({ page }) => {
  await page.goForward({ waitUntil: 'domcontentloaded', timeout: HISTORY_TIMEOUT_MS });
  return { success: true, url: page.url(), title: await page.title() };
};

// --- press_key ---
const pressKeyArgs = z.object({
  key: z.string(),
  ctrl: z.boolean(),
  shift: z.boolean(),
  alt: z.boolean(),
  meta: z.boolean(),
  selector: z.string().optional(),
});

/**
 * Keys that leave a field's value as it is: press_key may send them to a
 * password field. Every other key is refused there (headless key presses
 * are real input): characters, also by Playwright's code names (KeyA,
 * Digit1, Space), editing keys (Backspace, Delete) and shortcuts that edit
 * (Control+V), including a key string that names its own modifiers.
 */
const NON_EDITING_KEYS: ReadonlySet<string> = new Set([
  'Enter', 'Tab', 'Escape',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  'Shift', 'Control', 'Alt', 'Meta',
]);

const pressKey: ActionHandler = async ({ page, args }) => {
  const { key, ctrl, shift, alt, meta, selector } = parseArgs(pressKeyArgs, args, 'press_key');
  if (!key) return { success: false, error: 'press_key requires key' };
  const mods: string[] = [];
  if (ctrl) mods.push('Control');
  if (shift) mods.push('Shift');
  if (alt) mods.push('Alt');
  if (meta) mods.push('Meta');
  const combo = [...mods, key].join('+');
  const edits = !NON_EDITING_KEYS.has(key);
  if (selector) {
    const target = await page.waitForSelector(selector, { state: 'attached', timeout: ELEMENT_TIMEOUT_MS });
    if (edits) refusePassword(await target.evaluate(isPasswordElement), args);
    await target.focus();
  } else if (edits && args['allowPassword'] !== true) {
    refusePassword(await focusedIsPassword(page.mainFrame()), args);
  }
  await page.keyboard.press(combo);
  // `pressed` as on the Extension (the key without modifiers); `key` is the combination sent.
  return { success: true, key: combo, pressed: key };
};

// --- get_text ---
const getTextArgs = z.object({ selector: z.string().optional(), maxLength: z.number() });

const getText: ActionHandler = async ({ page, args }) => {
  const { selector, maxLength } = parseArgs(getTextArgs, args, 'get_text');
  const text = await page.innerText(selector || 'body', { timeout: ELEMENT_TIMEOUT_MS });
  const truncated = text.length > maxLength;
  return {
    success: true,
    text: text.slice(0, maxLength),
    truncated,
    // Same keys as the Extension (content/inspect.ts getText).
    totalLength: text.length,
    url: page.url(),
    title: await page.title(),
  };
};

// --- find_text ---
const findTextArgs = z.object({ query: z.string(), caseSensitive: z.boolean(), entireWord: z.boolean() });

const findText: ActionHandler = async ({ page, args }) => {
  const { query, caseSensitive, entireWord } = parseArgs(findTextArgs, args, 'find_text');
  // Same refusal as the Extension (background/tabs.ts findText).
  if (query === '') return { success: false, error: 'query is required (a non-empty string)' };
  // The rendered text of the top document (browser.find searches what is shown).
  const text = await page.evaluate(() => document.body?.innerText ?? document.documentElement.textContent ?? '');
  return { success: true, query, count: countOccurrences(text, query, caseSensitive, entireWord) };
};

// --- eval_chain ---
const evalChainArgs = z.object({
  steps: z.array(z.object({
    script: z.string(),
    label: z.string().optional(),
    captureConsole: z.boolean(),
    stopOnError: z.boolean(),
  })),
});

const evalChain: ActionHandler = async (c) => {
  const { page } = c;
  const { steps } = parseArgs(evalChainArgs, c.args, 'eval_chain');
  const results: Record<string, unknown>[] = [];
  let prev: unknown = null;
  for (const [i, step] of steps.entries()) {
    const label = step.label ?? `step_${i}`;
    const consoleMsgs: Array<{ type: string; text: string }> = [];
    const listener = (msg: ConsoleMessage): void => {
      consoleMsgs.push({ type: msg.type(), text: msg.text() });
    };
    if (step.captureConsole) page.on('console', listener);

    try {
      const wrapped = `(function($prev) { return (${step.script}); })(${JSON.stringify(prev)})`;
      const result = await evaluateScript(page, wrapped, c, `Step ${label}`);
      prev = result;
      results.push({ label, result, console: consoleMsgs, error: null });
    } catch (e) {
      results.push({
        label,
        result: null,
        console: consoleMsgs,
        error: e instanceof Error ? e.message : String(e),
      });
      if (step.stopOnError) break;
    } finally {
      if (step.captureConsole) page.removeListener('console', listener);
    }
  }
  return { success: true, steps: results, final: prev };
};

// --- wait_and_act ---
const waitAndActArgs = z.object({
  condition: z.string(),
  actionScript: z.string(),
  pollIntervalMs: z.number(),
  timeoutMs: z.number(),
});

/** pollIntervalMs as a usable interval: positive, at least WAIT_AND_ACT_POLL_MIN_MS. */
function pollInterval(v: number): number {
  return v > 0 ? Math.max(WAIT_AND_ACT_POLL_MIN_MS, v) : WAIT_AND_ACT_POLL_MS;
}

const waitAndAct: ActionHandler = async (c) => {
  const { page } = c;
  const a = parseArgs(waitAndActArgs, c.args, 'wait_and_act');
  const pollMs = pollInterval(a.pollIntervalMs);
  const timeoutMs = a.timeoutMs > 0 ? a.timeoutMs : WAIT_AND_ACT_DEFAULT_MS;
  const startedAt = Date.now();
  // Measured time, not the sum of the poll intervals: a slow condition
  // counts, and the loop ends whatever the interval is.
  const polling: Bound = { deadline: Math.min(startedAt + timeoutMs, c.deadline), signal: c.signal };
  for (;;) {
    let ready = false;
    try {
      ready = Boolean(await evaluateScript(page, a.condition, polling, 'The condition'));
    } catch {
      // the condition threw or hung: keep polling
    }
    if (ready) {
      // Run once: a failing action is reported, not retried.
      const result = await evaluateScript(page, a.actionScript, c, 'The action');
      return { success: true, result, elapsed_ms: Date.now() - startedAt };
    }
    if (c.signal?.aborted === true) {
      return { success: false, error: 'wait_and_act was cancelled: the caller gave up' };
    }
    const left = polling.deadline - Date.now();
    if (left <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(pollMs, left)));
  }
  return { success: false, error: `Condition not met within ${timeoutMs}ms` };
};

// --- inject_observer ---
const injectObserverArgs = z.object({
  selector: z.string(),
  observeAttributes: z.boolean(),
  observeChildList: z.boolean(),
  observeSubtree: z.boolean(),
});

const injectObserver: ActionHandler = async ({ page, args }) => {
  const a = parseArgs(injectObserverArgs, args, 'inject_observer');
  const script = `(function() {
    if (window.__fox_observer) window.__fox_observer.disconnect();
    window.__fox_mutations = window.__fox_mutations || [];
    const target = document.querySelector(${JSON.stringify(a.selector)}) || document.body;
    window.__fox_observer = new MutationObserver(mutations => {
      mutations.forEach(m => window.__fox_mutations.push({
        type: m.type,
        target: m.target.tagName + (m.target.id ? '#' + m.target.id : ''),
        addedNodes: m.addedNodes.length,
        removedNodes: m.removedNodes.length,
        attributeName: m.attributeName,
        ts: Date.now()
      }));
    });
    window.__fox_observer.observe(target, {
      attributes: ${a.observeAttributes},
      childList: ${a.observeChildList},
      subtree: ${a.observeSubtree}
    });
    return 'observer installed on ' + target.tagName;
  })()`;
  const result = await page.evaluate(script);
  return { success: true, message: result };
};

// --- remove_observer ---
const removeObserver: ActionHandler = async ({ page }) => {
  const result = await page.evaluate(`(function() {
    if (window.__fox_observer) {
      window.__fox_observer.disconnect();
      window.__fox_observer = null;
    }
    const count = (window.__fox_mutations || []).length;
    window.__fox_mutations = [];
    return { disconnected: true, mutationsFlushed: count };
  })()`);
  return { success: true, ...(isRecord(result) ? result : {}) };
};

// --- request_approval ---
const requestApproval: TablessHandler = async () => {
  return {
    success: false,
    approved: false,
    error:
      'No human is present in headless mode. Protected-site actions are approved ' +
      "through the MCP client's confirmation dialog (MCP elicitation) when it supports one.",
  };
};

// --- solve_captcha ---
/** detectOnly is set by handlers.ts for fox_detect_captcha (always true there). */
const solveCaptchaArgs = z.object({ detectOnly: z.boolean().optional() });

const solveCaptcha: ActionHandler = async ({ page, args }) => {
  const { detectOnly } = parseArgs(solveCaptchaArgs, args, 'solve_captcha');
  const raw = await page.evaluate(CAPTCHA_DETECT_JS);
  const detection = isRecord(raw) ? raw : {};
  if (detectOnly === true) {
    return { success: true, ...detection };
  }
  const widgets = Array.isArray(detection['widgets']) ? detection['widgets'].filter(isRecord) : [];
  const present = detection['present'] === true;
  const tokened = widgets.filter((w) => w['solved'] !== null);
  if (tokened.length > 0 && tokened.every((w) => w['solved'] === true)) {
    return {
      success: true,
      present: true,
      solved: true,
      widgets,
      message: 'Captcha already solved.',
    };
  }
  return {
    success: false,
    present,
    widgets,
    needs_human: true,
    error: present
      ? 'A captcha requires a human to solve and none is present in headless mode. ' +
        'Re-run this step in attended mode (the Firefox extension) so the person can complete it.'
      : 'No captcha detected.',
  };
};

// --- wait_for_navigation ---
const waitForNavigation: ActionHandler = async ({ page, args }) => {
  const { timeout } = parseArgs(timeoutArgs, args, 'wait_for_navigation');
  await page.waitForNavigation({ timeout });
  return { success: true, url: page.url(), title: await page.title() };
};

// --- wait_for_url ---
const waitForUrlArgs = timeoutArgs.extend({
  url: z.string().optional(),
  urlPattern: z.string().optional(),
});

const waitForUrl: ActionHandler = async ({ page, args }) => {
  // Schema: url = exact URL, urlPattern = regex (same as the extension).
  const { url, urlPattern, timeout } = parseArgs(waitForUrlArgs, args, 'wait_for_url');
  // A plain string would be read as a glob ('?' and '*' in query
  // strings), so compare the exact URL with a predicate instead.
  const target = url ? (u: URL): boolean => u.href === url
    : urlPattern ? new RegExp(urlPattern)
      : null;
  if (target === null) {
    return { success: false, error: 'Must provide url or urlPattern' };
  }
  await page.waitForURL(target, { timeout });
  return { success: true, url: page.url() };
};

// --- container actions (unsupported) ---
const containersUnsupported: TablessHandler = async () => {
  return {
    success: false,
    error: 'Container actions are not supported in headless mode. Use the Firefox extension.',
  };
};

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

const dispatch = (run: ActionHandler): HeadlessRoute => ({ kind: 'dispatch', needsPage: true, run });
const tabless = (run: TablessHandler): HeadlessRoute => ({ kind: 'dispatch', needsPage: false, run });
const UNSUPPORTED: HeadlessRoute = { kind: 'unsupported' };

/** Every BrowserCommand action and what the headless backend does with it. */
const HEADLESS_ROUTES: Readonly<Record<BrowserAction, HeadlessRoute>> = {
  // --- page interaction ---
  screenshot: dispatch(screenshot),
  click: dispatch(click),
  type: dispatch(type),
  scroll: dispatch(scroll),
  navigate: tabless(navigate),
  get_page_info: dispatch(getPageInfo),
  get_elements: dispatch(getElements),
  wait_for_element: dispatch(waitForElement),
  highlight: dispatch(highlight),
  execute_script: dispatch(executeScript),

  // --- tab management ---
  get_tabs: tabless(getTabs),
  get_tab_info: UNSUPPORTED,
  find_tabs: UNSUPPORTED,
  screenshot_all_tabs: UNSUPPORTED,
  create_tab: tabless(createTab),
  close_tab: dispatch(closeTab),
  focus_tab: dispatch(focusTab),

  // --- form / input ---
  get_value: dispatch(getValue),
  set_value: dispatch(setValue),
  select_option: dispatch(selectOption),
  hover: dispatch(hover),

  // --- reload / navigation ---
  refresh: dispatch(refresh),
  hard_refresh: UNSUPPORTED,
  reload_all: UNSUPPORTED,
  reload_by_url: UNSUPPORTED,
  go_back: dispatch(goBack),
  go_forward: dispatch(goForward),

  // --- wait / observe ---
  wait_for_change: UNSUPPORTED,
  wait_for_network_idle: dispatch(waitForNetworkIdle),
  observe_element: UNSUPPORTED,
  stop_observing: UNSUPPORTED,
  scroll_and_capture: UNSUPPORTED,
  click_and_wait: UNSUPPORTED,

  // --- console / network logging (not supported in headless mode) ---
  start_logging: UNSUPPORTED,
  stop_logging: UNSUPPORTED,
  get_console_logs: UNSUPPORTED,
  get_network_logs: UNSUPPORTED,
  clear_logs: UNSUPPORTED,

  // --- advanced scripting ---
  eval_chain: dispatch(evalChain),
  wait_and_act: dispatch(waitAndAct),
  press_key: dispatch(pressKey),
  get_text: dispatch(getText),

  // --- approval / workflow ---
  request_approval: tabless(requestApproval),
  run_workflow: UNSUPPORTED,
  solve_captcha: dispatch(solveCaptcha),
  cancel_human_wait: UNSUPPORTED,
  audit_page: UNSUPPORTED,
  inject_observer: dispatch(injectObserver),

  // --- P3-3 ---
  snapshot: dispatch(snapshot),
  find_text: dispatch(findText),
  handle_dialog: { kind: 'unlocked' },
  list_containers: tabless(containersUnsupported),
  open_in_container: tabless(containersUnsupported),
  wait_for_navigation: dispatch(waitForNavigation),
  wait_for_url: dispatch(waitForUrl),
  remove_observer: dispatch(removeObserver),
};

/** The route of `action`; actions that are no BrowserAction are unsupported. */
export function headlessRoute(action: string): HeadlessRoute {
  const known = BrowserActionSchema.safeParse(action);
  return known.success ? HEADLESS_ROUTES[known.data] : UNSUPPORTED;
}
