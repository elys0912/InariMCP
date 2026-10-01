/**
 * Routing table of the headless backend: what HeadlessBrowser.execute() does
 * with each BrowserCommand action, and the handlers of the actions it runs.
 *
 * Only playwright types are imported here (see headless-lifecycle.test.ts).
 */

import type { BrowserContext, ConsoleMessage, Page } from 'playwright';
import type { BrowserAction } from '@kitsune-mcp/shared';
import { argTimeout, filterAriaSnapshot } from './helpers.js';
import { isPasswordElement, PASSWORD_REFUSAL } from '../safety/password-guard.js';
import { getScreenshotsDir } from '../utils/screenshot.js';
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
  readonly context: BrowserContext | null;
  readonly activeTabId: number | null;
  readonly tabs: ReadonlyMap<number, Page>;
  /** Register `page` as a new tab and make it the active one; returns its id. */
  adoptTab(page: Page): number;
  /** Make the existing tab `tabId` the active one; returns its page. */
  activateTab(tabId: number): Page;
}

export interface ActionContext {
  /** The page of `tabId`, or the active page when no tabId was given. */
  page: Page;
  tabId: number | undefined;
  args: Record<string, unknown>;
  host: TabHost;
}

export type ActionHandler = (c: ActionContext) => Promise<Record<string, unknown>>;

/**
 * - dispatch: run under execute()'s lock, on the page of the target tab
 * - unlocked: execute() runs it itself outside the lock (handle_dialog: it
 *   waits for a dialog that a queued action may be about to open)
 * - unsupported: answered with "Unsupported headless action" (after the
 *   target tab was resolved, like a dispatch action)
 */
export type HeadlessRoute =
  | { kind: 'dispatch'; run: ActionHandler }
  | { kind: 'unlocked' }
  | { kind: 'unsupported' };

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
 * Fill the element `selector` resolves to, after the password guard.
 * The element is resolved once (waiting like page.fill() would), so the
 * element checked is the element filled.
 */
async function guardedFill(
  page: Page,
  selector: string,
  value: string,
  args: Record<string, unknown>,
): Promise<void> {
  const target = await page.waitForSelector(selector, { state: 'attached' });
  refusePassword(await target.evaluate(isPasswordElement), args);
  await target.fill(value);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// --- navigation ---
const navigate: ActionHandler = async ({ page, args, host }) => {
  const url = (args['url'] as string) ?? '';
  let target = page;
  if (args['newTab'] === true) {
    if (!host.context) return { success: false, error: 'No browser context' };
    target = await host.context.newPage();
    host.adoptTab(target);
  }
  await target.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  return {
    success: true,
    url: target.url(),
    title: await target.title(),
    ...(target !== page ? { tabId: host.activeTabId } : {}),
  };
};

// --- screenshot (file) ---
const screenshot: ActionHandler = async ({ page, args }) => {
  const dir = getScreenshotsDir();
  fs.mkdirSync(dir, { recursive: true });
  const filename = path.basename(
    (args['filename'] as string) || `screenshot_${Date.now()}.png`,
  );
  const filepath = path.join(dir, filename);
  await page.screenshot({
    path: filepath,
    fullPage: (args['fullPage'] as boolean) ?? false,
  });
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

/** fox_snapshot text is cut at this many characters. */
const SNAPSHOT_MAX_CHARS = 50_000;

// --- snapshot (accessibility tree as text; images are fox_screenshot's job) ---
const snapshot: ActionHandler = async ({ page, args }) => {
  const sel = (args['selector'] as string) || 'body';
  const loc = page.locator(sel);
  const matches = await loc.count();
  if (matches === 0) return { success: false, error: `No element matches selector: ${sel}` };
  const raw = await loc.first().ariaSnapshot({ timeout: 10_000 });
  const text = filterAriaSnapshot(raw, {
    ...(typeof args['maxDepth'] === 'number' ? { maxDepth: args['maxDepth'] } : {}),
    ...(args['includeText'] === false ? { includeText: false } : {}),
    ...(Array.isArray(args['roles']) ? { roles: args['roles'] as string[] } : {}),
  });
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
const click: ActionHandler = async ({ page, args }) => {
  const selector = args['selector'] as string | undefined;
  const x = args['x'] as number | undefined;
  const y = args['y'] as number | undefined;
  if (selector) {
    await page.click(selector, { timeout: 10_000 });
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
const type: ActionHandler = async ({ page, args }) => {
  const selector = args['selector'] as string | undefined;
  const text = (args['text'] as string) ?? '';
  if (selector) {
    await guardedFill(page, selector, text, args);
  } else {
    // Keyboard input goes to the focused element.
    const focused = await page.evaluateHandle(() => document.activeElement);
    refusePassword(await focused.evaluate(isPasswordElement), args);
    await page.keyboard.type(text);
  }
  return { success: true };
};

// --- scroll ---
const scroll: ActionHandler = async ({ page, args }) => {
  // Same precedence as the extension: toElement, then direction (of selector or window).
  const toElement = args['toElement'] as string | undefined;
  if (toElement) {
    const found = await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? '').trim().slice(0, 100),
        box: { x: r.x, y: r.y, width: r.width, height: r.height },
        position: { x: window.scrollX, y: window.scrollY },
      };
    }, toElement);
    if (!found) return { success: false, error: `No element matches toElement: ${toElement}` };
    return { success: true, scrolled: true, element: { tag: found.tag, text: found.text, box: found.box }, position: found.position, url: page.url() };
  }

  const direction = (args['direction'] as string | undefined) ?? 'down';
  const rawAmount = Number(args['amount'] ?? 300);
  const amount = Number.isFinite(rawAmount) ? Math.abs(rawAmount) : 300;
  const moved = await page.evaluate(
    ({ sel, dir, amt }: { sel: string | null; dir: string; amt: number }) => {
      const el = sel ? document.querySelector(sel) : null;
      if (sel && !el) return null;
      const doc = document.scrollingElement ?? document.documentElement;
      const pos = (): { x: number; y: number } =>
        el ? { x: el.scrollLeft, y: el.scrollTop } : { x: window.scrollX, y: window.scrollY };
      const by = (x: number, y: number): void => {
        const opts = { left: x, top: y, behavior: 'instant' as ScrollBehavior };
        if (el) el.scrollBy(opts); else window.scrollBy(opts);
      };
      const to = (y: number): void => {
        const opts = { top: y, behavior: 'instant' as ScrollBehavior };
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
      return { scrolled: before.x !== after.x || before.y !== after.y, position: after };
    },
    { sel: (args['selector'] as string | undefined) ?? null, dir: direction, amt: amount },
  );
  if (!moved) return { success: false, error: `No element matches selector: ${String(args['selector'])}` };
  return {
    success: true,
    scrolled: moved.scrolled,
    position: moved.position,
    target: args['selector'] ? 'element' : 'window',
    direction,
    url: page.url(),
  };
};

// --- hover ---
const hover: ActionHandler = async ({ page, args }) => {
  const selector = (args['selector'] as string) ?? '';
  await page.hover(selector);
  return { success: true };
};

// --- refresh ---
const refresh: ActionHandler = async ({ page }) => {
  await page.reload();
  return { success: true };
};

// --- highlight ---
const highlight: ActionHandler = async ({ page, args }) => {
  const selector = (args['selector'] as string) ?? '';
  await page.$eval(
    selector,
    (el: Element) => {
      (el as HTMLElement).style.outline = '3px solid red';
      setTimeout(() => { (el as HTMLElement).style.outline = ''; }, 2000);
    },
  );
  return { success: true };
};

// --- get_page_info ---
const getPageInfo: ActionHandler = async ({ page }) => {
  return { success: true, url: page.url(), title: await page.title() };
};

// --- get_elements ---
const getElements: ActionHandler = async ({ page, args }) => {
  const selector = (args['selector'] as string) ?? 'a, button, input, select, textarea';
  const elements = await page.$$(selector);
  const results: Record<string, unknown>[] = [];
  for (const el of elements.slice(0, 50)) {
    try {
      const tag = await el.evaluate((e: Element) => e.tagName.toLowerCase());
      const text = ((await el.innerText()) ?? '').slice(0, 100);
      const box = await el.boundingBox();
      results.push({ tag, text, box });
    } catch {
      // element detached
    }
  }
  return { success: true, elements: results };
};

// --- execute_script ---
const executeScript: ActionHandler = async ({ page, args }) => {
  const script = (args['script'] as string) ?? '';
  const result = await page.evaluate(script);
  return { success: true, result };
};

// --- wait_for_element ---
const waitForElement: ActionHandler = async ({ page, args }) => {
  const selector = (args['selector'] as string) ?? '';
  const timeout = argTimeout(args, 10_000);
  await page.waitForSelector(selector, { timeout });
  return { success: true };
};

// --- wait_for_network_idle ---
const waitForNetworkIdle: ActionHandler = async ({ page, args }) => {
  const timeout = argTimeout(args, 10_000);
  await page.waitForLoadState('networkidle', { timeout });
  return { success: true };
};

// --- get_tabs ---
const getTabs: ActionHandler = async ({ host }) => {
  const tabs: Record<string, unknown>[] = [];
  for (const [tid, p] of host.tabs) {
    try {
      tabs.push({
        id: tid,
        url: p.url(),
        title: await p.title(),
        active: tid === host.activeTabId,
      });
    } catch {
      // page closed between iteration
    }
  }
  return { success: true, tabs, totalTabs: tabs.length };
};

// --- create_tab ---
const createTab: ActionHandler = async ({ args, host }) => {
  if (!host.context) return { success: false, error: 'No browser context' };
  const url = (args['url'] as string) ?? 'about:blank';
  const newPage = await host.context.newPage();
  if (url !== 'about:blank') {
    await newPage.goto(url);
  }
  const newId = host.adoptTab(newPage);
  return { success: true, tabId: newId, url: newPage.url() };
};

// --- close_tab ---
const closeTab: ActionHandler = async ({ tabId, host }) => {
  if (tabId === undefined || !host.tabs.has(tabId)) {
    return { success: false, error: `No headless tab with id ${tabId}` };
  }
  await host.tabs.get(tabId)!.close();
  // `closed` as on the Extension; closedTabId kept for older readers.
  return { success: true, closed: tabId, closedTabId: tabId };
};

// --- focus_tab ---
const focusTab: ActionHandler = async ({ tabId, host }) => {
  if (tabId === undefined || !host.tabs.has(tabId)) {
    return { success: false, error: `No headless tab with id ${tabId}` };
  }
  const focused = host.activateTab(tabId);
  await focused.bringToFront();
  return { success: true, tabId, url: focused.url() };
};

// --- get_value ---
const getValue: ActionHandler = async ({ page, args }) => {
  const selector = (args['selector'] as string) ?? '';
  const value = await page.$eval(selector, (el: Element) => (el as HTMLInputElement).value);
  return { success: true, value };
};

// --- set_value ---
const setValue: ActionHandler = async ({ page, args }) => {
  const selector = (args['selector'] as string) ?? '';
  const value = (args['value'] as string) ?? '';
  await guardedFill(page, selector, value, args);
  return { success: true };
};

// --- select_option ---
const selectOption: ActionHandler = async ({ page, args }) => {
  const selector = (args['selector'] as string) ?? '';
  const want = {
    value: args['value'] as string | undefined,
    index: args['index'] === undefined ? undefined : Number(args['index']),
    text: args['text'] as string | undefined,
  };
  if (want.value === undefined && want.index === undefined && want.text === undefined) {
    return { success: false, error: 'select_option requires value, text, or index' };
  }
  // Look the option up first (value, then index, then exact text, as the
  // extension does): selectOption() alone reports a miss as success.
  const info = await page.locator(selector).first().evaluate(
    (el: Element, w: { value?: string; index?: number; text?: string }) => {
      if (!(el instanceof HTMLSelectElement)) return { kind: 'not-select' as const };
      const options = Array.from(el.options).map((o) => ({ value: o.value, text: o.text }));
      let idx = -1;
      if (w.value !== undefined) idx = options.findIndex((o) => o.value === w.value);
      else if (w.index !== undefined) idx = w.index >= 0 && w.index < options.length ? w.index : -1;
      else if (w.text !== undefined) idx = options.findIndex((o) => o.text === w.text);
      return { kind: 'ok' as const, idx, options };
    },
    {
      ...(want.value !== undefined ? { value: want.value } : {}),
      ...(want.index !== undefined ? { index: want.index } : {}),
      ...(want.text !== undefined ? { text: want.text } : {}),
    },
    { timeout: 5_000 },
  );
  if (info.kind === 'not-select') {
    return { success: false, error: `Element is not a <select>: ${selector}` };
  }
  if (info.idx < 0) {
    const what = want.value !== undefined ? `value "${want.value}"`
      : want.index !== undefined ? `index ${want.index}` : `text "${want.text}"`;
    return {
      success: false,
      error: `No option matches ${what}`,
      availableOptions: info.options.slice(0, 20),
    };
  }
  const chosen = await page.selectOption(selector, { index: info.idx }, { timeout: 5_000 });
  if (chosen.length === 0) {
    return { success: false, error: `Option was not selected: ${selector}` };
  }
  const picked = info.options[info.idx]!;
  return { success: true, selected: true, value: picked.value, text: picked.text };
};

// --- go_back ---
const goBack: ActionHandler = async ({ page }) => {
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 });
  return { success: true, url: page.url(), title: await page.title() };
};

// --- go_forward ---
const goForward: ActionHandler = async ({ page }) => {
  await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15_000 });
  return { success: true, url: page.url(), title: await page.title() };
};

// --- press_key ---
const pressKey: ActionHandler = async ({ page, args }) => {
  const key = (args['key'] as string) ?? '';
  if (!key) return { success: false, error: 'press_key requires key' };
  const mods: string[] = [];
  if (args['ctrl']) mods.push('Control');
  if (args['shift']) mods.push('Shift');
  if (args['alt']) mods.push('Alt');
  if (args['meta']) mods.push('Meta');
  const combo = [...mods, key].join('+');
  const selector = args['selector'] as string | undefined;
  if (selector) await page.focus(selector);
  await page.keyboard.press(combo);
  return { success: true, key: combo };
};

// --- get_text ---
const getText: ActionHandler = async ({ page, args }) => {
  const selector = (args['selector'] as string) || 'body';
  const maxLength = Number(args['maxLength'] ?? 20_000);
  const text = await page.innerText(selector, { timeout: 10_000 });
  const truncated = text.length > maxLength;
  return {
    success: true,
    text: text.slice(0, maxLength),
    truncated,
    total_length: text.length,
    url: page.url(),
  };
};

// --- find_text ---
const findText: ActionHandler = async ({ page, args }) => {
  const query = (args['query'] as string) ?? '';
  const count = await page.locator(`:text("${query.replace(/"/g, '\\"')}")`).count();
  return { success: true, query, count };
};

// --- eval_chain ---
const evalChain: ActionHandler = async ({ page, args }) => {
  const steps = (args['steps'] as Array<Record<string, unknown>>) ?? [];
  const results: Record<string, unknown>[] = [];
  let prev: unknown = null;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const script = (step['script'] as string) ?? '';
    const label = (step['label'] as string) ?? `step_${i}`;
    const capture = step['captureConsole'] !== false;
    const stopOnError = step['stopOnError'] !== false;

    const consoleMsgs: Array<{ type: string; text: string }> = [];

    // FIX: store reference so we can actually remove it later
    const listener = (msg: ConsoleMessage) => {
      consoleMsgs.push({ type: msg.type(), text: msg.text() });
    };
    if (capture) page.on('console', listener);

    try {
      const wrapped = `(function($prev) { return (${script}); })(${JSON.stringify(prev)})`;
      const result = await page.evaluate(wrapped);
      prev = result;
      results.push({ label, result, console: consoleMsgs, error: null });
    } catch (e) {
      results.push({
        label,
        result: null,
        console: consoleMsgs,
        error: e instanceof Error ? e.message : String(e),
      });
      if (stopOnError) break;
    } finally {
      if (capture) page.removeListener('console', listener);
    }
  }
  return { success: true, steps: results, final: prev };
};

// --- wait_and_act ---
const waitAndAct: ActionHandler = async ({ page, args }) => {
  const condition = (args['condition'] as string) ?? 'true';
  const actionScript = (args['actionScript'] as string) ?? '';
  const pollMs = (args['pollIntervalMs'] as number) ?? 200;
  const timeoutMs = argTimeout(args, 15_000);
  let elapsed = 0;
  while (elapsed < timeoutMs) {
    try {
      const ready = await page.evaluate(condition);
      if (ready) {
        const result = await page.evaluate(actionScript);
        return { success: true, result, elapsed_ms: elapsed };
      }
    } catch {
      // condition threw — keep polling
    }
    await new Promise((r) => setTimeout(r, pollMs));
    elapsed += pollMs;
  }
  return { success: false, error: `Condition not met within ${timeoutMs}ms` };
};

// --- inject_observer ---
const injectObserver: ActionHandler = async ({ page, args }) => {
  const selector = (args['selector'] as string) ?? 'body';
  const observeAttrs = args['observeAttributes'] !== false;
  const observeChildren = args['observeChildList'] !== false;
  const observeSubtree = args['observeSubtree'] !== false;
  const script = `(function() {
    if (window.__fox_observer) window.__fox_observer.disconnect();
    window.__fox_mutations = window.__fox_mutations || [];
    const target = document.querySelector(${JSON.stringify(selector)}) || document.body;
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
      attributes: ${observeAttrs},
      childList: ${observeChildren},
      subtree: ${observeSubtree}
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
  return { success: true, ...(result as Record<string, unknown>) };
};

// --- request_approval ---
const requestApproval: ActionHandler = async () => {
  return {
    success: false,
    approved: false,
    error:
      'No human is present in headless mode. Protected-site actions are approved ' +
      "through the MCP client's confirmation dialog (MCP elicitation) when it supports one.",
  };
};

// --- solve_captcha ---
const solveCaptcha: ActionHandler = async ({ page, args }) => {
  const detection = (await page.evaluate(CAPTCHA_DETECT_JS)) as Record<string, unknown>;
  if (args['detectOnly']) {
    return { success: true, ...detection };
  }
  const widgets = (detection['widgets'] as Array<Record<string, unknown>>) ?? [];
  const tokened = widgets.filter((w) => w['solved'] !== null);
  if (tokened.length > 0 && tokened.every((w) => w['solved'])) {
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
    present: (detection['present'] as boolean) ?? false,
    widgets,
    needs_human: true,
    error: (detection['present'] as boolean)
      ? 'A captcha requires a human to solve and none is present in headless mode. ' +
        'Re-run this step in attended mode (the Firefox extension) so the person can complete it.'
      : 'No captcha detected.',
  };
};

// --- wait_for_navigation ---
const waitForNavigation: ActionHandler = async ({ page, args }) => {
  const timeout = argTimeout(args, 30_000);
  await page.waitForNavigation({ timeout });
  return { success: true, url: page.url(), title: await page.title() };
};

// --- wait_for_url ---
const waitForUrl: ActionHandler = async ({ page, args }) => {
  // Schema: url = exact URL, urlPattern = regex (same as the extension).
  const exact = args['url'] as string | undefined;
  const regex = args['urlPattern'] as string | undefined;
  if (!exact && !regex) {
    return { success: false, error: 'Must provide url or urlPattern' };
  }
  const timeout = argTimeout(args, 15_000);
  // A plain string would be read as a glob ('?' and '*' in query
  // strings), so compare the exact URL with a predicate instead.
  await page.waitForURL(
    exact ? (u: URL) => u.href === exact : new RegExp(regex!),
    { timeout },
  );
  return { success: true, url: page.url() };
};

// --- container actions (unsupported) ---
const containersUnsupported: ActionHandler = async () => {
  return {
    success: false,
    error: 'Container actions are not supported in headless mode. Use the Firefox extension.',
  };
};

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

const dispatch = (run: ActionHandler): HeadlessRoute => ({ kind: 'dispatch', run });
const UNSUPPORTED: HeadlessRoute = { kind: 'unsupported' };

/** Every BrowserCommand action and what the headless backend does with it. */
export const HEADLESS_ROUTES: Readonly<Record<BrowserAction, HeadlessRoute>> = {
  // --- page interaction ---
  screenshot: dispatch(screenshot),
  click: dispatch(click),
  type: dispatch(type),
  scroll: dispatch(scroll),
  navigate: dispatch(navigate),
  get_page_info: dispatch(getPageInfo),
  get_elements: dispatch(getElements),
  wait_for_element: dispatch(waitForElement),
  highlight: dispatch(highlight),
  execute_script: dispatch(executeScript),

  // --- tab management ---
  get_tabs: dispatch(getTabs),
  get_tab_info: UNSUPPORTED,
  find_tabs: UNSUPPORTED,
  screenshot_all_tabs: UNSUPPORTED,
  create_tab: dispatch(createTab),
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
  request_approval: dispatch(requestApproval),
  run_workflow: UNSUPPORTED,
  solve_captcha: dispatch(solveCaptcha),
  cancel_human_wait: UNSUPPORTED,
  audit_page: UNSUPPORTED,
  inject_observer: dispatch(injectObserver),

  // --- P3-3 ---
  snapshot: dispatch(snapshot),
  find_text: dispatch(findText),
  handle_dialog: { kind: 'unlocked' },
  list_containers: dispatch(containersUnsupported),
  open_in_container: dispatch(containersUnsupported),
  wait_for_navigation: dispatch(waitForNavigation),
  wait_for_url: dispatch(waitForUrl),
  remove_observer: dispatch(removeObserver),
};

/** The route of `action`; actions that are no BrowserAction are unsupported. */
export function headlessRoute(action: string): HeadlessRoute {
  return Object.hasOwn(HEADLESS_ROUTES, action)
    ? HEADLESS_ROUTES[action as BrowserAction]
    : UNSUPPORTED;
}
