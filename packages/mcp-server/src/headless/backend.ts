import type { Browser, BrowserContext, Page, ConsoleMessage, Dialog } from 'playwright';
import { ENV, LEGACY_ENV } from '@kitsune-mcp/shared';
import { headlessStartupTimeoutMs } from '../utils/headless-env.js';
import { argTimeout, filterAriaSnapshot, ignoredParamWarnings } from './helpers.js';
import { getSafetyGuard } from '../safety/guard.js';
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
// HeadlessBrowser
// ---------------------------------------------------------------------------

function log(msg: string): void {
  process.stderr.write(`[KitsuneMCP:Headless] ${msg}\n`);
}

/** Longest a dialog nobody asked for may stay open before it is dismissed (it blocks the page). */
const DIALOG_GRACE_MS = 2_000;
/** An armed fox_handle_dialog applies to the next dialog within this time only. */
const ARM_TTL_MS = 30_000;
/** fox_snapshot text is cut at this many characters. */
const SNAPSHOT_MAX_CHARS = 50_000;

interface DialogEvent {
  type: string;
  message: string;
  handled: 'accept' | 'dismiss';
  /** Dismissed by the backend because no fox_handle_dialog was waiting or armed. */
  auto: boolean;
}

export class HeadlessBrowser {
  // Dialogs are tracked per tab outside the execute() lock: a fox_handle_dialog
  // waiting for a dialog must not block the click that opens it.
  private _pendingDialog = new Map<number, Dialog>();
  private _dialogWaiters = new Map<number, { deliver: (d: Dialog) => void; cancel: () => void }>();
  private _armed = new Map<number, { action: 'accept' | 'dismiss'; promptText?: string; until: number }>();
  private _dialogEvents = new Map<number, DialogEvent[]>();
  private _browser: Browser | null = null;
  private _context: BrowserContext | null = null;
  private _page: Page | null = null;
  private _tabs = new Map<number, Page>();
  private _nextTabId = 1;
  private _activeTabId: number | null = null;
  private _lockChain: Promise<void> = Promise.resolve();

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    const executablePath =
      process.env[ENV.FOX_EXECUTABLE] ??
      process.env[LEGACY_ENV.CLAUDE_BROWSER_EXECUTABLE] ??
      undefined;

    const timeout = headlessStartupTimeoutMs();

    // Loaded on demand, so the daemon and relay start without playwright installed.
    const { firefox } = await import('playwright');
    this._browser = await firefox.launch({
      headless: true,
      timeout,
      ...(executablePath ? { executablePath } : {}),
    });

    this._context = await this._browser.newContext({
      viewport: { width: 1280, height: 800 },
    });

    this._page = await this._context.newPage();
    this._registerTab(this._page);

    log(`Firefox (headless) started — timeout ${timeout}ms`);
  }

  async stop(): Promise<void> {
    const browser = this._browser;
    // isReady() is false from here on, also when close() throws.
    this._browser = null;
    this._context = null;
    this._page = null;
    this._tabs.clear();
    this._activeTabId = null;
    this._pendingDialog.clear();
    for (const w of this._dialogWaiters.values()) w.cancel();
    this._dialogWaiters.clear();
    this._armed.clear();
    this._dialogEvents.clear();
    if (browser) await browser.close();
    log('stopped');
  }

  isReady(): boolean {
    return this._page !== null;
  }

  // -----------------------------------------------------------------------
  // Tab bookkeeping
  // -----------------------------------------------------------------------

  private _registerTab(page: Page): number {
    const tabId = this._nextTabId++;
    this._tabs.set(tabId, page);
    this._activeTabId = tabId;
    page.on('close', () => this._forgetTab(tabId));
    page.on('dialog', (d: Dialog) => this._onDialog(tabId, d));
    return tabId;
  }

  private _forgetTab(tabId: number): void {
    this._tabs.delete(tabId);
    this._pendingDialog.delete(tabId);
    this._dialogWaiters.get(tabId)?.cancel();
    this._dialogWaiters.delete(tabId);
    this._armed.delete(tabId);
    this._dialogEvents.delete(tabId);
    if (this._activeTabId === tabId) {
      const first = this._tabs.keys().next();
      this._activeTabId = first.done ? null : first.value;
      this._page = this._activeTabId !== null
        ? this._tabs.get(this._activeTabId) ?? null
        : null;
    }
  }

  private async _getPage(tabId?: number): Promise<Page> {
    if (tabId !== undefined) {
      const page = this._tabs.get(tabId);
      if (!page) throw new Error(`No headless tab with id ${tabId}`);
      return page;
    }
    if (!this._page) throw new Error('Headless browser not started');
    return this._page;
  }

  // -----------------------------------------------------------------------
  // Password guard
  // -----------------------------------------------------------------------

  private async _assertNotPassword(page: Page, selector: string): Promise<void> {
    if (getSafetyGuard().config.allowPasswordTyping) return;
    try {
      const isPassword = await page.$eval(
        selector,
        (el: Element) => {
          const input = el as HTMLInputElement;
          return (
            input.tagName === 'INPUT' &&
            (input.type === 'password' ||
              ['current-password', 'new-password'].includes(
                input.getAttribute('autocomplete') ?? '',
              ))
          );
        },
      );
      if (isPassword) {
        throw new Error(
          'Refused: target is a password field. Credentials belong in a ' +
          'password manager, not automated typing. Set ' +
          '"allowPasswordTyping": true in ~/.kitsune-mcp/safety.json to override.',
        );
      }
    } catch (e) {
      // Re-throw our own refusal; swallow selector resolution failures
      if (e instanceof Error && e.message.startsWith('Refused:')) throw e;
    }
  }

  // -----------------------------------------------------------------------
  // Execute (serialised via promise-chain lock)
  // -----------------------------------------------------------------------

  async execute(
    action: string,
    tabId: number | undefined,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Not serialised: it waits for a dialog that a queued action may be about to open.
    if (action === 'handle_dialog') {
      return this._finish(action, tabId ?? this._activeTabId, args, await this._run(action, () => this._handleDialog(tabId, args)));
    }

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const prev = this._lockChain;
    this._lockChain = gate;
    await prev;
    try {
      // The tab this action targets, fixed before it can change the active tab.
      const target = tabId ?? this._activeTabId;
      return this._finish(action, target, args, await this._run(action, () => this._dispatch(action, tabId, args)));
    } finally {
      release();
    }
  }

  private async _run(
    action: string,
    fn: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    try {
      return await fn();
    } catch (e) {
      log(`${action} failed: ${e instanceof Error ? e.message : String(e)}`);
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Add what the caller should know to a result: parameters that were ignored,
   * and dialogs that were handled (or auto-dismissed) on this tab meanwhile.
   * A failed result only carries text, so its warnings are appended to `error`.
   */
  private _finish(
    action: string,
    id: number | null,
    args: Record<string, unknown>,
    result: Record<string, unknown>,
  ): Record<string, unknown> {
    const warnings = [
      ...(Array.isArray(result['warnings']) ? (result['warnings'] as string[]) : []),
      ...ignoredParamWarnings(action, args),
    ];
    const drain = id !== null && action !== 'handle_dialog';
    const events = drain ? this._dialogEvents.get(id) : undefined;
    if (drain) this._dialogEvents.delete(id);
    if (events && events.length > 0) {
      result['dialogs'] = events;
      for (const ev of events.filter((e) => e.auto)) {
        warnings.push(
          `dialog "${ev.message.slice(0, 80)}" was dismissed automatically; ` +
          'call fox_handle_dialog before the action that opens a dialog to accept it',
        );
      }
    }
    delete result['warnings'];
    if (warnings.length > 0) {
      if (result['success'] === false && typeof result['error'] === 'string') {
        result['error'] = `${result['error']} (warnings: ${warnings.join('; ')})`;
      } else {
        result['warnings'] = warnings;
      }
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // Dialogs
  // -----------------------------------------------------------------------

  private _onDialog(tabId: number, dialog: Dialog): void {
    const waiter = this._dialogWaiters.get(tabId);
    if (waiter) {
      this._dialogWaiters.delete(tabId);
      waiter.deliver(dialog);
      return;
    }
    const armed = this._armed.get(tabId);
    this._armed.delete(tabId);
    if (armed && Date.now() <= armed.until) {
      void this._settle(dialog, armed.action, armed.promptText, (info) => {
        this._recordDialog(tabId, { ...info, auto: false });
      });
      return;
    }
    // Nobody asked for it (or the request expired): an open dialog blocks the
    // page and the action that opened it, so give fox_handle_dialog a moment,
    // then dismiss.
    this._pendingDialog.set(tabId, dialog);
    setTimeout(() => {
      if (this._pendingDialog.get(tabId) !== dialog) return;
      this._pendingDialog.delete(tabId);
      void this._settle(dialog, 'dismiss', undefined, (info) => {
        this._recordDialog(tabId, { ...info, auto: true });
      });
    }, DIALOG_GRACE_MS).unref();
  }

  private _recordDialog(tabId: number, ev: DialogEvent): void {
    const list = this._dialogEvents.get(tabId) ?? [];
    list.push(ev);
    this._dialogEvents.set(tabId, list);
  }

  private async _settle(
    dialog: Dialog,
    action: 'accept' | 'dismiss',
    promptText?: string,
    /** Called before the dialog is settled, so a result that waits for it already finds the record. */
    onInfo?: (info: { type: string; message: string; handled: 'accept' | 'dismiss' }) => void,
  ): Promise<{ type: string; message: string; handled: 'accept' | 'dismiss' }> {
    const info = { type: dialog.type(), message: dialog.message(), handled: action };
    onInfo?.(info);
    try {
      if (action === 'accept') await dialog.accept(promptText);
      else await dialog.dismiss();
    } catch (e) {
      log(`dialog ${action} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return info;
  }

  private async _handleDialog(
    tabId: number | undefined,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = tabId ?? this._activeTabId;
    if (id === null || !this._tabs.has(id)) {
      return { success: false, error: `No headless tab with id ${tabId ?? 'active'}` };
    }
    const action = args['action'] === 'accept' ? 'accept' : 'dismiss';
    const promptText = args['promptText'] as string | undefined;
    const timeout = argTimeout(args, 10_000);

    const settle = async (d: Dialog): Promise<Record<string, unknown>> => {
      const info = await this._settle(d, action, promptText);
      return { success: true, type: info.type, message: info.message, handled: info.handled };
    };

    const pending = this._pendingDialog.get(id);
    if (pending) {
      this._pendingDialog.delete(id);
      return settle(pending);
    }

    const dialog = await new Promise<Dialog | null>((resolve) => {
      const waiter = {
        deliver: (d: Dialog): void => { clearTimeout(timer); resolve(d); },
        // the tab was closed or the browser stopped
        cancel: (): void => { clearTimeout(timer); resolve(null); },
      };
      const timer = setTimeout(() => {
        if (this._dialogWaiters.get(id) === waiter) this._dialogWaiters.delete(id);
        resolve(null);
      }, timeout);
      this._dialogWaiters.set(id, waiter);
    });
    if (dialog) return settle(dialog);
    if (!this._tabs.has(id)) return { success: false, error: `Tab ${id} was closed while waiting for a dialog` };

    this._armed.set(id, {
      action,
      ...(promptText !== undefined ? { promptText } : {}),
      until: Date.now() + ARM_TTL_MS,
    });
    return {
      success: true,
      handled: false,
      armed: action,
      message:
        `No dialog open; the next dialog on this tab within ${ARM_TTL_MS / 1000}s will be ` +
        `${action === 'accept' ? 'accepted' : 'dismissed'}`,
    };
  }

  // -----------------------------------------------------------------------
  // Dispatch
  // -----------------------------------------------------------------------

  private async _dispatch(
    action: string,
    tabId: number | undefined,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const page = await this._getPage(tabId);

    switch (action) {
      // --- navigation ---
      case 'navigate': {
        const url = (args['url'] as string) ?? '';
        let target = page;
        if (args['newTab'] === true) {
          if (!this._context) return { success: false, error: 'No browser context' };
          target = await this._context.newPage();
          this._page = target;
          this._registerTab(target);
        }
        await target.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        return {
          success: true,
          url: target.url(),
          title: await target.title(),
          ...(target !== page ? { tabId: this._activeTabId } : {}),
        };
      }

      // --- screenshot (file) ---
      case 'screenshot': {
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
      }

      // --- snapshot (accessibility tree as text; images are fox_screenshot's job) ---
      case 'snapshot': {
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
      }

      // --- click ---
      case 'click': {
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
      }

      // --- type ---
      case 'type': {
        const selector = args['selector'] as string | undefined;
        const text = (args['text'] as string) ?? '';
        if (selector) {
          await this._assertNotPassword(page, selector);
          await page.fill(selector, text);
        } else {
          await page.keyboard.type(text);
        }
        return { success: true };
      }

      // --- scroll ---
      case 'scroll': {
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
      }

      // --- hover ---
      case 'hover': {
        const selector = (args['selector'] as string) ?? '';
        await page.hover(selector);
        return { success: true };
      }

      // --- refresh ---
      case 'refresh': {
        await page.reload();
        return { success: true };
      }

      // --- highlight ---
      case 'highlight': {
        const selector = (args['selector'] as string) ?? '';
        await page.$eval(
          selector,
          (el: Element) => {
            (el as HTMLElement).style.outline = '3px solid red';
            setTimeout(() => { (el as HTMLElement).style.outline = ''; }, 2000);
          },
        );
        return { success: true };
      }

      // --- get_page_info ---
      case 'get_page_info': {
        return { success: true, url: page.url(), title: await page.title() };
      }

      // --- get_elements ---
      case 'get_elements': {
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
      }

      // --- execute_script ---
      case 'execute_script': {
        const script = (args['script'] as string) ?? '';
        const result = await page.evaluate(script);
        return { success: true, result };
      }

      // --- wait_for_element ---
      case 'wait_for_element': {
        const selector = (args['selector'] as string) ?? '';
        const timeout = argTimeout(args, 10_000);
        await page.waitForSelector(selector, { timeout });
        return { success: true };
      }

      // --- wait_for_network_idle ---
      case 'wait_for_network_idle': {
        const timeout = argTimeout(args, 10_000);
        await page.waitForLoadState('networkidle', { timeout });
        return { success: true };
      }

      // --- get_tabs ---
      case 'get_tabs': {
        const tabs: Record<string, unknown>[] = [];
        for (const [tid, p] of this._tabs) {
          try {
            tabs.push({
              id: tid,
              url: p.url(),
              title: await p.title(),
              active: tid === this._activeTabId,
            });
          } catch {
            // page closed between iteration
          }
        }
        return { success: true, tabs, totalTabs: tabs.length };
      }

      // --- create_tab ---
      case 'create_tab': {
        if (!this._context) return { success: false, error: 'No browser context' };
        const url = (args['url'] as string) ?? 'about:blank';
        const newPage = await this._context.newPage();
        if (url !== 'about:blank') {
          await newPage.goto(url);
        }
        this._page = newPage;
        const newId = this._registerTab(newPage);
        return { success: true, tabId: newId, url: newPage.url() };
      }

      // --- close_tab ---
      case 'close_tab': {
        if (tabId === undefined || !this._tabs.has(tabId)) {
          return { success: false, error: `No headless tab with id ${tabId}` };
        }
        await this._tabs.get(tabId)!.close();
        return { success: true, closedTabId: tabId };
      }

      // --- focus_tab ---
      case 'focus_tab': {
        if (tabId === undefined || !this._tabs.has(tabId)) {
          return { success: false, error: `No headless tab with id ${tabId}` };
        }
        this._activeTabId = tabId;
        this._page = this._tabs.get(tabId)!;
        await this._page.bringToFront();
        return { success: true, tabId, url: this._page.url() };
      }

      // --- get_value ---
      case 'get_value': {
        const selector = (args['selector'] as string) ?? '';
        const value = await page.$eval(selector, (el: Element) => (el as HTMLInputElement).value);
        return { success: true, value };
      }

      // --- set_value ---
      case 'set_value': {
        const selector = (args['selector'] as string) ?? '';
        const value = (args['value'] as string) ?? '';
        await this._assertNotPassword(page, selector);
        await page.fill(selector, value);
        return { success: true };
      }

      // --- select_option ---
      case 'select_option': {
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
      }

      // --- go_back ---
      case 'go_back': {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 });
        return { success: true, url: page.url(), title: await page.title() };
      }

      // --- go_forward ---
      case 'go_forward': {
        await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15_000 });
        return { success: true, url: page.url(), title: await page.title() };
      }

      // --- press_key ---
      case 'press_key': {
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
      }

      // --- get_text ---
      case 'get_text': {
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
      }

      // --- find_text ---
      case 'find_text': {
        const query = (args['query'] as string) ?? '';
        const count = await page.locator(`:text("${query.replace(/"/g, '\\"')}")`).count();
        return { success: true, query, count };
      }

      // --- eval_chain ---
      case 'eval_chain': {
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
      }

      // --- wait_and_act ---
      case 'wait_and_act': {
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
      }

      // --- inject_observer ---
      case 'inject_observer': {
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
      }

      // --- remove_observer ---
      case 'remove_observer': {
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
      }

      // --- request_approval ---
      case 'request_approval': {
        return {
          success: false,
          approved: false,
          error:
            'No human is present in headless mode. Protected-site actions are approved ' +
            "through the MCP client's confirmation dialog (MCP elicitation) when it supports one.",
        };
      }

      // --- solve_captcha ---
      case 'solve_captcha': {
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
      }

      // handle_dialog is handled in execute() (outside the lock), see _handleDialog()

      // --- wait_for_navigation ---
      case 'wait_for_navigation': {
        const timeout = argTimeout(args, 30_000);
        await page.waitForNavigation({ timeout });
        return { success: true, url: page.url(), title: await page.title() };
      }

      // --- wait_for_url ---
      case 'wait_for_url': {
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
      }

      // --- container actions (unsupported) ---
      case 'list_containers':
      case 'open_in_container': {
        return {
          success: false,
          error: 'Container actions are not supported in headless mode. Use the Firefox extension.',
        };
      }

      default:
        return { success: false, error: `Unsupported headless action: ${action}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _headlessBrowser: HeadlessBrowser | null = null;

export function getHeadlessBrowser(): HeadlessBrowser | null {
  return _headlessBrowser;
}

export async function initHeadlessBrowser(): Promise<HeadlessBrowser> {
  _headlessBrowser = new HeadlessBrowser();
  await _headlessBrowser.start();
  return _headlessBrowser;
}
