import type { Browser, BrowserContext, Page, Dialog } from 'playwright';
import { ENV, LEGACY_ENV } from '@kitsune-mcp/shared';
import { headlessStartupTimeoutMs } from '../utils/headless-env.js';
import { argTimeout, ignoredParamWarnings } from './helpers.js';
import { headlessRoute, type TabHost } from './actions.js';
import {
  ARM_TTL_MS,
  DIALOG_GRACE_MS,
  DIALOG_MESSAGE_PREVIEW_CHARS,
  HANDLE_DIALOG_DEFAULT_MS,
  VIEWPORT,
} from './limits.js';
import { stderrLogger } from '@kitsune-mcp/shared/node';
import { currentCommandContext, type CommandContext } from '../connection/manager.js';

// ---------------------------------------------------------------------------
// HeadlessBrowser
// ---------------------------------------------------------------------------

const log = stderrLogger('Headless');

const NOT_RUN_ERROR =
  'Not run: the command timed out or was cancelled while it waited for an earlier headless command';

interface DialogEvent {
  type: string;
  message: string;
  handled: 'accept' | 'dismiss';
  /** Dismissed by the backend because no fox_handle_dialog was waiting or armed. */
  auto: boolean;
}

/** How a fox_handle_dialog wait ended without a dialog. */
type WaitEnd = 'timeout' | 'closed' | 'superseded' | 'cancelled';

interface DialogWaiter {
  deliver: (d: Dialog) => void;
  /** End the wait without a dialog. */
  end: (why: Exclude<WaitEnd, 'timeout'>) => void;
}

export class HeadlessBrowser {
  // Dialogs are tracked per tab outside the execute() lock: a fox_handle_dialog
  // waiting for a dialog must not block the click that opens it.
  private _pendingDialog = new Map<number, Dialog>();
  private _dialogWaiters = new Map<number, DialogWaiter>();
  private _armed = new Map<number, { action: 'accept' | 'dismiss'; promptText?: string; until: number }>();
  private _dialogEvents = new Map<number, DialogEvent[]>();
  private _browser: Browser | null = null;
  private _context: BrowserContext | null = null;
  private _page: Page | null = null;
  private _tabs = new Map<number, Page>();
  private _nextTabId = 1;
  private _activeTabId: number | null = null;
  private _lockChain: Promise<void> = Promise.resolve();

  /** The tab state the action handlers of actions.ts see. */
  private readonly _host: TabHost = (() => {
    const self = this;
    return {
      get context() { return self._context; },
      get activeTabId() { return self._activeTabId; },
      get tabs() { return self._tabs; },
      adoptTab(page: Page): number {
        self._page = page;
        return self._registerTab(page);
      },
      activateTab(tabId: number): Page {
        self._activeTabId = tabId;
        self._page = self._tabs.get(tabId)!;
        return self._page;
      },
    };
  })();

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    const executablePath =
      process.env[ENV.FOX_EXECUTABLE] ??
      process.env[LEGACY_ENV.CLAUDE_BROWSER_EXECUTABLE] ??
      undefined;

    const timeout = headlessStartupTimeoutMs();

    // Loaded on demand, so the daemon and relay start without playwright
    // installed (it is an optionalDependency: FOX_HEADLESS only).
    let firefox: typeof import('playwright').firefox;
    try {
      ({ firefox } = await import('playwright'));
    } catch (err: unknown) {
      throw new Error(
        'FOX_HEADLESS needs the optional dependency playwright, which is not installed ' +
        `(${err instanceof Error ? err.message : String(err)}). Install it in packages/mcp-server ` +
        '(npm install playwright) and its Firefox (npx playwright install firefox).',
      );
    }
    this._browser = await firefox.launch({
      headless: true,
      timeout,
      ...(executablePath ? { executablePath } : {}),
    });

    this._context = await this._browser.newContext({
      viewport: { ...VIEWPORT },
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
    for (const w of this._dialogWaiters.values()) w.end('closed');
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
    this._dialogWaiters.get(tabId)?.end('closed');
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
  // Execute (serialised via promise-chain lock)
  // -----------------------------------------------------------------------

  /**
   * Run one action. `ctx` is the deadline and cancellation of the command
   * (connection/manager.ts); by default the one of the command being sent.
   * An action whose command was given up while it waited for the lock is
   * not run: the caller has already been told it failed and may send it
   * again.
   */
  async execute(
    action: string,
    tabId: number | undefined,
    args: Record<string, unknown>,
    ctx: CommandContext | undefined = currentCommandContext(),
  ): Promise<Record<string, unknown>> {
    const deadline = ctx?.deadline ?? Infinity;
    const signal = ctx?.signal;
    const route = headlessRoute(action);
    // Not serialised: it waits for a dialog that a queued action may be about to open.
    if (route.kind === 'unlocked') {
      return this._finish(action, tabId ?? this._activeTabId, args, await this._run(action, () => this._handleDialog(tabId, args, signal)));
    }

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const prev = this._lockChain;
    this._lockChain = gate;
    await prev;
    try {
      if (signal?.aborted === true || Date.now() >= deadline) {
        return { success: false, error: NOT_RUN_ERROR };
      }
      // The tab this action targets, fixed before it can change the active tab.
      const target = tabId ?? this._activeTabId;
      return this._finish(action, target, args, await this._run(action, async () => {
        const page = await this._getPage(tabId);
        if (route.kind === 'unsupported') {
          return { success: false, error: `Unsupported headless action: ${action}` };
        }
        return route.run({ page, tabId, args, host: this._host, deadline, signal });
      }));
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
          `dialog "${ev.message.slice(0, DIALOG_MESSAGE_PREVIEW_CHARS)}" was dismissed automatically; ` +
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
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const id = tabId ?? this._activeTabId;
    if (id === null || !this._tabs.has(id)) {
      return { success: false, error: `No headless tab with id ${tabId ?? 'active'}` };
    }
    const action = args['action'] === 'accept' ? 'accept' : 'dismiss';
    const promptText = args['promptText'] as string | undefined;
    const timeout = argTimeout(args, HANDLE_DIALOG_DEFAULT_MS);

    const settle = async (d: Dialog): Promise<Record<string, unknown>> => {
      const info = await this._settle(d, action, promptText);
      return { success: true, type: info.type, message: info.message, handled: info.handled };
    };

    const pending = this._pendingDialog.get(id);
    if (pending) {
      this._pendingDialog.delete(id);
      return settle(pending);
    }

    // A later fox_handle_dialog on the same tab replaces this one: the
    // earlier wait ends without arming, so it cannot accept a later,
    // unrelated dialog.
    this._dialogWaiters.get(id)?.end('superseded');
    const outcome = await new Promise<Dialog | WaitEnd>((resolve) => {
      const finish = (v: Dialog | WaitEnd): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (this._dialogWaiters.get(id) === waiter) this._dialogWaiters.delete(id);
        resolve(v);
      };
      const waiter: DialogWaiter = { deliver: finish, end: finish };
      const onAbort = (): void => { finish('cancelled'); };
      const timer = setTimeout(() => { finish('timeout'); }, timeout);
      this._dialogWaiters.set(id, waiter);
      if (signal?.aborted === true) finish('cancelled');
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
    if (typeof outcome !== 'string') return settle(outcome);
    if (outcome === 'closed' || !this._tabs.has(id)) {
      return { success: false, error: `Tab ${id} was closed while waiting for a dialog` };
    }
    if (outcome === 'superseded') {
      return { success: false, error: 'Replaced by a later fox_handle_dialog on the same tab; nothing was armed' };
    }
    if (outcome === 'cancelled') {
      return { success: false, error: 'Cancelled: the caller gave up on fox_handle_dialog; nothing was armed' };
    }

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
