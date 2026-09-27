import type { Browser, BrowserContext, Page, ConsoleMessage, Dialog } from 'playwright';
import { firefox } from 'playwright';
import { ENV, LEGACY_ENV, ENV_DEFAULTS } from '@kitsune-mcp/shared';
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

export class HeadlessBrowser {
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

    const timeout =
      Number(process.env[ENV.FOX_HEADLESS_STARTUP_TIMEOUT]) ||
      ENV_DEFAULTS.FOX_HEADLESS_STARTUP_TIMEOUT;

    this._browser = await firefox.launch({
      headless: true,
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
    if (this._browser) {
      await this._browser.close();
      this._browser = null;
    }
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
    return tabId;
  }

  private _forgetTab(tabId: number): void {
    this._tabs.delete(tabId);
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
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const prev = this._lockChain;
    this._lockChain = gate;
    await prev;
    try {
      return await this._dispatch(action, tabId, args);
    } catch (e) {
      log(`${action} failed: ${e instanceof Error ? e.message : String(e)}`);
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      release();
    }
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
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        return { success: true, url: page.url(), title: await page.title() };
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

      // --- snapshot (base64, no file) ---
      case 'snapshot': {
        const buf = await page.screenshot({
          fullPage: (args['fullPage'] as boolean) ?? false,
        });
        return {
          success: true,
          base64: buf.toString('base64'),
          size: buf.length,
          url: page.url(),
          title: await page.title(),
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
          return { success: false, error: 'click requires selector or x+y coordinates' };
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
        const deltaX = Number(args['deltaX'] ?? 0);
        const deltaY = Number(args['deltaY'] ?? 300);
        await page.mouse.wheel(deltaX, deltaY);
        return { success: true };
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
        const timeout = (args['timeout'] as number) ?? 10_000;
        await page.waitForSelector(selector, { timeout });
        return { success: true };
      }

      // --- wait_for_network_idle ---
      case 'wait_for_network_idle': {
        const timeout = (args['timeout'] as number) ?? 10_000;
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
        if (args['value'] !== undefined) {
          await page.selectOption(selector, { value: args['value'] as string });
        } else if (args['text'] !== undefined) {
          await page.selectOption(selector, { label: args['text'] as string });
        } else if (args['index'] !== undefined) {
          await page.selectOption(selector, { index: Number(args['index']) });
        } else {
          return { success: false, error: 'select_option requires value, text, or index' };
        }
        return { success: true };
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
        const query = (args['text'] as string) ?? '';
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
        const timeoutMs = (args['timeoutMs'] as number) ?? 15_000;
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
            'No human is present in headless mode. Use MCP elicitation for protected actions.',
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

      // --- handle_dialog ---
      case 'handle_dialog': {
        const dialogAction = (args['action'] as string) ?? 'dismiss';
        const promptText = args['text'] as string | undefined;
        const timeout = (args['timeout'] as number) ?? 10_000;
        return new Promise<Record<string, unknown>>((resolve) => {
          const timer = setTimeout(() => {
            page.removeListener('dialog', onDialog);
            resolve({ success: false, error: `No dialog appeared within ${timeout}ms` });
          }, timeout);
          const onDialog = async (dialog: Dialog) => {
            clearTimeout(timer);
            const info = { type: dialog.type(), message: dialog.message() };
            try {
              if (dialogAction === 'accept') {
                await dialog.accept(promptText);
              } else {
                await dialog.dismiss();
              }
              resolve({ success: true, ...info, handled: dialogAction });
            } catch (e) {
              resolve({
                success: false,
                ...info,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          };
          page.once('dialog', onDialog);
        });
      }

      // --- wait_for_navigation ---
      case 'wait_for_navigation': {
        const timeout = (args['timeout'] as number) ?? 30_000;
        await page.waitForNavigation({ timeout });
        return { success: true, url: page.url(), title: await page.title() };
      }

      // --- wait_for_url ---
      case 'wait_for_url': {
        const pattern = (args['pattern'] as string) ?? '**';
        const timeout = (args['timeout'] as number) ?? 30_000;
        await page.waitForURL(pattern, { timeout });
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
