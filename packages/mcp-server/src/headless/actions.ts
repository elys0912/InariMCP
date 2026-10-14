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

import type { BrowserContext, ElementHandle, Page } from 'playwright';
import { z } from 'zod';
import { BrowserActionSchema, type BrowserAction } from '@inari-mcp/shared';
import { screenshotStem } from '@inari-mcp/shared/node';
import { countOccurrences, filterAriaSnapshot, parseArgs } from './helpers.js';
import { isPasswordElement, PASSWORD_REFUSAL } from '../safety/password-guard.js';
import { focusedIsPassword } from './focus.js';
import { getScreenshotsDir } from '../utils/screenshot.js';
import { errorMessage } from '../utils/errors.js';
import { SCROLL_DIRECTIONS } from '../tools/schemas.js';
import {
  AVAILABLE_OPTIONS_MAX,
  ELEMENT_TEXT_MAX_CHARS,
  ELEMENT_TIMEOUT_MS,
  GET_ELEMENTS_MAX,
  HIGHLIGHT_OUTLINE,
  HISTORY_TIMEOUT_MS,
  NAVIGATE_TIMEOUT_MS,
  SELECT_OPTION_TIMEOUT_MS,
  SNAPSHOT_MAX_CHARS,
  WAIT_GIVE_UP_SLACK_MS,
} from './limits.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Captcha detection — the same heuristics as the Extension's content script
// (content/captcha.ts detectCaptcha); tests/headless-helpers.test.ts checks
// that every string below appears there.
// ---------------------------------------------------------------------------

/** Selectors and response-token field names of the captcha detection. */
export const CAPTCHA_SELECTORS = {
  recaptcha: '.g-recaptcha, iframe[src*="recaptcha"], #g-recaptcha-response',
  recaptchaChecked: '.recaptcha-checkbox-checked',
  recaptchaToken: 'g-recaptcha-response',
  hcaptcha: '.h-captcha, iframe[src*="hcaptcha"], textarea[name="h-captcha-response"]',
  hcaptchaToken: 'h-captcha-response',
  turnstile: '.cf-turnstile, iframe[src*="challenges.cloudflare.com"], input[name="cf-turnstile-response"]',
  turnstileToken: 'cf-turnstile-response',
  generic: 'img[src*="captcha" i], input[name*="captcha" i], [id*="captcha" i], [class*="captcha" i]',
} as const;

interface CaptchaWidget {
  type: 'recaptcha' | 'hcaptcha' | 'turnstile' | 'generic';
  /** Whether its response token is filled in; null when it cannot be told (generic). */
  solved: boolean | null;
}

/** Captcha widgets on the page. Self-contained (runs in the page). */
function detectCaptcha(s: typeof CAPTCHA_SELECTORS): { present: boolean; widgets: CaptchaWidget[] } {
  const widgets: CaptchaWidget[] = [];
  const tokened = (name: string): boolean => {
    const el = document.querySelector(`textarea[name="${CSS.escape(name)}"], input[name="${CSS.escape(name)}"]`);
    return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value.length > 0;
  };
  if (document.querySelector(s.recaptcha)) {
    widgets.push({ type: 'recaptcha', solved: tokened(s.recaptchaToken) || document.querySelector(s.recaptchaChecked) !== null });
  }
  if (document.querySelector(s.hcaptcha)) widgets.push({ type: 'hcaptcha', solved: tokened(s.hcaptchaToken) });
  if (document.querySelector(s.turnstile)) widgets.push({ type: 'turnstile', solved: tokened(s.turnstileToken) });
  if (widgets.length === 0 && document.querySelector(s.generic)) widgets.push({ type: 'generic', solved: null });
  return { present: widgets.length > 0, widgets };
}

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

/** The dialog handling of HeadlessBrowser (backend.ts), which keeps the dialog state. */
export interface DialogHost {
  handleDialog(tabId: number | undefined, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<Result>;
}

interface UnlockedContext {
  tabId: number | undefined;
  args: Record<string, unknown>;
  signal: AbortSignal | undefined;
  dialogs: DialogHost;
}

type UnlockedHandler = (c: UnlockedContext) => Promise<Result>;

/**
 * - dispatch: run under execute()'s lock. With needsPage, on the page of the
 *   target tab, and the result names that tab (url, tabId); without, also
 *   when no tab is open (tab list, new tabs).
 * - unlocked: run outside the lock (handle_dialog: it waits for a dialog
 *   that a queued action may be about to open)
 * - unsupported: answered with "Unsupported headless action" (after the
 *   target tab was resolved, like a dispatch action)
 */
type HeadlessRoute =
  | { kind: 'dispatch'; needsPage: true; run: ActionHandler }
  | { kind: 'dispatch'; needsPage: false; run: TablessHandler }
  | { kind: 'unlocked'; run: UnlockedHandler }
  | { kind: 'unsupported' };

/** The error of an action on "the active tab" while no tab is open (the last one was closed). */
export const NO_TAB_ERROR =
  "No headless tab is open: open one with fox_tab action 'create' or fox_navigate with newTab: true";

// ---------------------------------------------------------------------------
// Bounded waits
// ---------------------------------------------------------------------------

/** What bounds a wait: a deadline (Date.now() value) and an optional abort. */
interface Bound {
  deadline: number;
  signal: AbortSignal | undefined;
}

/**
 * `work` given up after `ms`, at `bound.deadline` or when `bound.signal`
 * aborts, whichever comes first. Giving up does not stop the work; it frees
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
    work.then(
      (v) => { done(); resolve(v); },
      (e: unknown) => { done(); reject(e instanceof Error ? e : new Error(errorMessage(e))); },
    );
  });
}

/**
 * A Playwright wait of up to `timeout` ms, cut to `bound.deadline` and given
 * up when `bound.signal` aborts, so a cancelled wait frees execute()'s lock
 * at once (the Playwright wait itself runs on until its own timeout).
 * `wait` gets the timeout to pass to Playwright: at least 1 ms, since
 * Playwright reads 0 as "no timeout".
 */
function boundedWait<T>(bound: Bound, timeout: number, what: string, wait: (ms: number) => Promise<T>): Promise<T> {
  const ms = Math.max(1, Math.min(timeout, bound.deadline - Date.now()));
  // Playwright's own timeout error (it names what was awaited) comes first.
  return bounded(wait(ms), bound, ms + WAIT_GIVE_UP_SLACK_MS, what);
}

// ---------------------------------------------------------------------------
// Password guard
// ---------------------------------------------------------------------------

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
  // Always PNG, named as the Native Host names the Extension's captures:
  // Playwright takes the format from the extension and refuses any other
  // than png / jpeg / webp (a name without one included).
  const filename = `${screenshotStem(requested) ?? `screenshot_${Date.now()}`}.png`;
  const filepath = path.join(dir, filename);
  await page.screenshot({ path: filepath, type: 'png', fullPage: fullPage === true });
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

// --- wait_for_element ---
const waitForElementArgs = selectorArgs.merge(timeoutArgs).extend({ visible: z.boolean() });

const waitForElement: ActionHandler = async (c) => {
  const { selector, timeout, visible } = parseArgs(waitForElementArgs, c.args, 'wait_for_element');
  await boundedWait(c, timeout, 'wait_for_element', (ms) =>
    c.page.waitForSelector(selector, { timeout: ms, state: visible ? 'visible' : 'attached' }));
  return { success: true };
};

// --- wait_for_network_idle ---
const waitForNetworkIdle: ActionHandler = async (c) => {
  const { timeout } = parseArgs(timeoutArgs, c.args, 'wait_for_network_idle');
  await boundedWait(c, timeout, 'wait_for_network_idle', (ms) =>
    c.page.waitForLoadState('networkidle', { timeout: ms }));
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
  }
  // The key goes to whatever has focus now: a selector that cannot take focus
  // (a div) leaves the previously focused element, maybe a password field.
  if (edits) refusePassword(await focusedIsPassword(page.mainFrame()), args);
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

// --- request_approval ---
const requestApproval: TablessHandler = () => Promise.resolve({
  success: false,
  approved: false,
  error:
    'No human is present in headless mode. Tool calls that need approval are approved ' +
    "through the MCP client's confirmation dialog (MCP elicitation) when it supports one.",
});

// --- solve_captcha ---
/** detectOnly is set by handlers.ts for fox_detect_captcha (always true there). */
const solveCaptchaArgs = z.object({ detectOnly: z.boolean().optional() });

const solveCaptcha: ActionHandler = async ({ page, args }) => {
  const { detectOnly } = parseArgs(solveCaptchaArgs, args, 'solve_captcha');
  const detection = await page.evaluate(detectCaptcha, CAPTCHA_SELECTORS);
  if (detectOnly === true) {
    return { success: true, ...detection };
  }
  const { widgets, present } = detection;
  const tokened = widgets.filter((w) => w.solved !== null);
  if (tokened.length > 0 && tokened.every((w) => w.solved === true)) {
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
const waitForNavigationArgs = timeoutArgs.extend({ waitUntil: z.enum(['load', 'domcontentloaded']) });

const waitForNavigation: ActionHandler = async (c) => {
  const { page } = c;
  const { timeout, waitUntil } = parseArgs(waitForNavigationArgs, c.args, 'wait_for_navigation');
  // The next navigation of the main frame (page.waitForNavigation is
  // deprecated), then its load state; both within one timeout.
  await boundedWait(c, timeout, 'wait_for_navigation', async (ms) => {
    const end = Date.now() + ms;
    await page.waitForEvent('framenavigated', { predicate: (f) => f === page.mainFrame(), timeout: ms });
    await page.waitForLoadState(waitUntil, { timeout: Math.max(1, end - Date.now()) });
  });
  return { success: true, url: page.url(), title: await page.title() };
};

// --- wait_for_url ---
const waitForUrlArgs = timeoutArgs.extend({
  url: z.string().optional(),
  urlPattern: z.string().optional(),
});

const waitForUrl: ActionHandler = async (c) => {
  const { page } = c;
  // Schema: url = exact URL, urlPattern = regex (same as the extension).
  const { url, urlPattern, timeout } = parseArgs(waitForUrlArgs, c.args, 'wait_for_url');
  // A plain string would be read as a glob ('?' and '*' in query
  // strings), so compare the exact URL with a predicate instead.
  const target = url ? (u: URL): boolean => u.href === url
    : urlPattern ? new RegExp(urlPattern)
      : null;
  if (target === null) {
    return { success: false, error: 'Must provide url or urlPattern' };
  }
  await boundedWait(c, timeout, 'wait_for_url', (ms) => page.waitForURL(target, { timeout: ms }));
  return { success: true, url: page.url() };
};

// --- container actions (unsupported) ---
const containersUnsupported: TablessHandler = () => Promise.resolve({
  success: false,
  error: 'Container actions are not supported in headless mode. Use the Firefox extension.',
});

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

  // --- tab management ---
  get_tabs: tabless(getTabs),
  screenshot_all_tabs: UNSUPPORTED,
  create_tab: tabless(createTab),
  close_tab: dispatch(closeTab),
  focus_tab: dispatch(focusTab),

  // --- form / input ---
  set_value: dispatch(setValue),
  select_option: dispatch(selectOption),
  hover: dispatch(hover),

  // --- reload / navigation ---
  refresh: dispatch(refresh),
  hard_refresh: UNSUPPORTED,
  go_back: dispatch(goBack),
  go_forward: dispatch(goForward),

  // --- wait ---
  wait_for_network_idle: dispatch(waitForNetworkIdle),
  scroll_and_capture: UNSUPPORTED,

  // --- keyboard / text ---
  press_key: dispatch(pressKey),
  get_text: dispatch(getText),

  // --- approval / workflow ---
  request_approval: tabless(requestApproval),
  run_workflow: UNSUPPORTED,
  solve_captcha: dispatch(solveCaptcha),
  cancel_human_wait: UNSUPPORTED,
  audit_page: UNSUPPORTED,

  // --- P3-3 ---
  snapshot: dispatch(snapshot),
  find_text: dispatch(findText),
  handle_dialog: { kind: 'unlocked', run: (c) => c.dialogs.handleDialog(c.tabId, c.args, c.signal) },
  list_containers: tabless(containersUnsupported),
  open_in_container: tabless(containersUnsupported),
  wait_for_navigation: dispatch(waitForNavigation),
  wait_for_url: dispatch(waitForUrl),
};

/** The route of `action`; actions that are no BrowserAction are unsupported. */
export function headlessRoute(action: string): HeadlessRoute {
  const known = BrowserActionSchema.safeParse(action);
  return known.success ? HEADLESS_ROUTES[known.data] : UNSUPPORTED;
}
