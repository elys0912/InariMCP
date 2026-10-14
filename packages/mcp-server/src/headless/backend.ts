import type { Browser, BrowserContext, Page, Dialog } from 'playwright';
import { z } from 'zod';
import { ENV, type BrowserCommand, type BrowserResponse } from '@inari-mcp/shared';
import { headlessStartupTimeoutMs, resolveFoxEnv } from '../utils/headless-env.js';
import { ignoredParamWarnings, parseArgs } from './helpers.js';
import { headlessRoute, NO_TAB_ERROR, type DialogHost, type HeadlessRoute, type TabHost } from './actions.js';
import { commandApprovalOf, floorRefusal, type CommandApproval } from './approval-floor.js';
import {
  ARM_TTL_MS,
  DIALOG_GRACE_MS,
  DIALOG_MESSAGE_PREVIEW_CHARS,
  VIEWPORT,
} from './limits.js';
import { stderrLogger } from '@inari-mcp/shared/node';
import { currentCommandContext, type CommandContext } from '../connection/manager.js';

// ---------------------------------------------------------------------------
// HeadlessBrowser
// ---------------------------------------------------------------------------

const log = stderrLogger('Headless');

const NOT_STARTED_ERROR = 'Headless browser not started';

const NOT_RUN_ERROR =
  'Not run: the command timed out or was cancelled while it waited for an earlier headless command';

const DIALOG_ACTIONS = ['accept', 'dismiss'] as const;

/** What is done with a dialog. */
type DialogAction = (typeof DIALOG_ACTIONS)[number];

/** fox_handle_dialog's arguments as the tool schema delivers them (helpers.ts parseArgs). */
const handleDialogArgs = z.object({
  action: z.enum(DIALOG_ACTIONS),
  promptText: z.string().optional(),
  timeout: z.number(),
});

/** A dialog and what was done with it. */
interface DialogInfo {
  type: string;
  message: string;
  handled: DialogAction;
}

interface DialogEvent extends DialogInfo {
  /** Dismissed by the backend because no fox_handle_dialog was waiting or armed. */
  auto: boolean;
}

/** A fox_handle_dialog that found no dialog: it applies to the next one until `until`. */
interface ArmedDialog {
  action: DialogAction;
  promptText?: string;
  /** Date.now() value after which it no longer applies. */
  until: number;
}

/** One action to run: what execute() and runCommand() share. */
interface HeadlessCall {
  action: string;
  tabId: number | undefined;
  args: Record<string, unknown>;
  ctx: CommandContext | undefined;
}

/** The routes run under the lock. */
type LockedRoute = Exclude<HeadlessRoute, { kind: 'unlocked' }>;

/**
 * A result of runCommand() as the BrowserResponse the connection manager
 * routes. A refusal of the approval floor carries its safetyDecision, as
 * the Extension's does.
 */
function responseOf(requestId: string, result: Record<string, unknown>): BrowserResponse {
  const decision = result['safetyDecision'];
  return {
    requestId,
    success: result['success'] === true,
    data: result,
    error: typeof result['error'] === 'string' ? result['error'] : undefined,
    ...(typeof decision === 'string' ? { safetyDecision: decision } : {}),
  };
}

/** A closed gate: `promise` resolves once `open` is called. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => { /* replaced below */ };
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
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
  private _armed = new Map<number, ArmedDialog>();
  private _dialogEvents = new Map<number, DialogEvent[]>();
  private _browser: Browser | null = null;
  private _context: BrowserContext | null = null;
  private _page: Page | null = null;
  private _tabs = new Map<number, Page>();
  private _nextTabId = 1;
  private _activeTabId: number | null = null;
  private _lockChain: Promise<void> = Promise.resolve();

  /** The tab state the action handlers of actions.ts see (arrow functions: `this` is this browser). */
  private readonly _host: TabHost = {
    context: () => {
      if (!this._context) throw new Error(NOT_STARTED_ERROR);
      return this._context;
    },
    activeTabId: () => this._activeTabId,
    tabs: () => this._tabs,
    adoptTab: (page) => {
      this._page = page;
      return this._registerTab(page);
    },
    activateTab: (tabId, page) => {
      this._activeTabId = tabId;
      this._page = page;
    },
  };

  /** The dialog handling the unlocked route of handle_dialog (actions.ts) calls. */
  private readonly _dialogHost: DialogHost = {
    handleDialog: (tabId, args, signal) => this._handleDialog(tabId, args, signal),
  };

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    // A blank value counts as unset: Playwright's own Firefox is used.
    const executablePath = resolveFoxEnv(process.env, ENV.FOX_EXECUTABLE);

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
        { cause: err },
      );
    }
    this._browser = await firefox.launch({
      headless: true,
      timeout,
      ...(executablePath !== undefined ? { executablePath } : {}),
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

  /** Started and not stopped (also while no tab is open). */
  isReady(): boolean {
    return this._context !== null;
  }

  /**
   * Pages open in the browser context, registered as tabs or not (0 when
   * not started). For the tests: a page that is no tab is a leak.
   * @internal
   */
  contextPageCount(): number {
    return this._context?.pages().length ?? 0;
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

  /**
   * The page of `tabId`, or of the active tab when undefined; null when no
   * tab is open (the last one was closed).
   */
  private _targetPage(tabId: number | undefined): Page | null {
    if (this._context === null) throw new Error(NOT_STARTED_ERROR);
    if (tabId === undefined) return this._page;
    const page = this._tabs.get(tabId);
    if (!page) throw new Error(`No headless tab with id ${tabId}`);
    return page;
  }

  // -----------------------------------------------------------------------
  // Execute (serialised via promise-chain lock)
  // -----------------------------------------------------------------------

  /**
   * Run a command of the MCP Server (daemon/main.ts): the action behind the
   * approval floor (approval-floor.ts), which is checked right before it
   * runs, against the page it runs on. `ctx` as in execute().
   */
  async runCommand(
    command: BrowserCommand,
    ctx: CommandContext | undefined = currentCommandContext(),
  ): Promise<BrowserResponse> {
    const args = command.data ?? {};
    const result = await this._execute(
      { action: command.action, tabId: command.tabId, args, ctx },
      commandApprovalOf(command),
    );
    return responseOf(command.requestId, result);
  }

  /**
   * Run one action, without the approval floor: the tests drive the actions
   * with it, the daemon runs every command through runCommand() (no other
   * caller in src: headless-lifecycle.test.ts checks). `ctx` is
   * the deadline and cancellation of the command (connection/manager.ts);
   * by default the one of the command being sent. An action whose command
   * was given up while it waited for the lock is not run: the caller has
   * already been told it failed and may send it again.
   *
   * @internal
   */
  execute(
    action: string,
    tabId: number | undefined,
    args: Record<string, unknown>,
    ctx: CommandContext | undefined = currentCommandContext(),
  ): Promise<Record<string, unknown>> {
    return this._execute({ action, tabId, args, ctx }, null);
  }

  /** execute() and runCommand(); `approval` null: no floor. */
  private async _execute(call: HeadlessCall, approval: CommandApproval | null): Promise<Record<string, unknown>> {
    const { action, tabId, args, ctx } = call;
    const route = headlessRoute(action);
    // Not serialised: it waits for a dialog that a queued action may be about to open.
    if (route.kind === 'unlocked') {
      const result = await this._run(action, async () => {
        return this._floorRefusal(call, this._urlOfTab(tabId), approval) ??
          route.run({ tabId, args, signal: ctx?.signal, dialogs: this._dialogHost });
      });
      return this._finish(action, tabId ?? this._activeTabId, args, result);
    }

    const lock = gate();
    const prev = this._lockChain;
    this._lockChain = lock.promise;
    await prev;
    try {
      return await this._executeLocked(call, route, approval);
    } finally {
      lock.open();
    }
  }

  /** The part of _execute() that holds the lock. */
  private async _executeLocked(
    call: HeadlessCall,
    route: LockedRoute,
    approval: CommandApproval | null,
  ): Promise<Record<string, unknown>> {
    const { action, tabId, args, ctx } = call;
    // The deadline and the cancellation of the command.
    const limits = { deadline: ctx?.deadline ?? Infinity, signal: ctx?.signal };
    if (limits.signal?.aborted === true || Date.now() >= limits.deadline) {
      return { success: false, error: NOT_RUN_ERROR };
    }
    // The tab this action targets, fixed before it can change the active tab.
    const target = tabId ?? this._activeTabId;
    const result = await this._run(action, async () => {
      const page = this._targetPage(tabId);
      const base = { tabId, args, host: this._host, ...limits };
      if (route.kind === 'dispatch' && !route.needsPage) {
        return this._floorRefusal(call, page?.url() ?? null, approval) ?? route.run({ ...base, page });
      }
      if (page === null) throw new Error(NO_TAB_ERROR);
      if (route.kind === 'unsupported') {
        return { success: false, error: `Unsupported headless action: ${action}` };
      }
      return this._floorRefusal(call, page.url(), approval) ?? route.run({ ...base, page });
    });
    if (route.kind === 'dispatch' && route.needsPage) this._reportTab(result, target);
    return this._finish(action, target, args, result);
  }

  /** The URL of the page of `tabId`, or of the active tab when undefined; null without one. */
  private _urlOfTab(tabId: number | undefined): string | null {
    const id = tabId ?? this._activeTabId;
    const page = id === null ? undefined : this._tabs.get(id);
    return page?.url() ?? null;
  }

  /** The approval floor's refusal of `call` on the page at `pageUrl`, or null (also without a floor). */
  private _floorRefusal(
    call: HeadlessCall,
    pageUrl: string | null,
    approval: CommandApproval | null,
  ): Record<string, unknown> | null {
    return approval === null ? null : floorRefusal(call.action, call.args, pageUrl, approval);
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
   * Name the tab a successful action ran on: its id and the URL it is on
   * now (a click may have navigated it), as the Extension adds
   * `url`. The guard (safety/guard.ts noteUrl / checkReachedUrl) records and
   * checks them. Values the action set itself are kept; a tab the action
   * closed is not reported.
   */
  private _reportTab(result: Record<string, unknown>, id: number | null): void {
    if (result['success'] !== true || id === null) return;
    const page = this._tabs.get(id);
    if (!page) return;
    if (typeof result['url'] !== 'string') result['url'] = page.url();
    if (typeof result['tabId'] !== 'number') result['tabId'] = id;
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
      ...(Array.isArray(result['warnings'])
        ? result['warnings'].filter((w): w is string => typeof w === 'string')
        : []),
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
    action: DialogAction,
    promptText?: string,
    /** Called before the dialog is settled, so a result that waits for it already finds the record. */
    onInfo?: (info: DialogInfo) => void,
  ): Promise<DialogInfo> {
    const info: DialogInfo = { type: dialog.type(), message: dialog.message(), handled: action };
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
    const { action, promptText, timeout } = parseArgs(handleDialogArgs, args, 'handle_dialog');

    const settle = async (d: Dialog): Promise<Record<string, unknown>> => {
      const info = await this._settle(d, action, promptText);
      return { success: true, type: info.type, message: info.message, handled: info.handled };
    };

    const pending = this._pendingDialog.get(id);
    if (pending) {
      this._pendingDialog.delete(id);
      return settle(pending);
    }

    const outcome = await this._waitForDialog(id, timeout, signal);
    if (typeof outcome !== 'string') return settle(outcome);
    const refusal = this._dialogWaitRefusal(id, outcome);
    if (refusal !== null) return refusal;
    return this._armDialog(id, action, promptText);
  }

  /**
   * Wait up to `timeout` ms for a dialog on tab `id`. A later
   * fox_handle_dialog on the same tab replaces this one: the earlier wait
   * ends without arming, so it cannot accept a later, unrelated dialog.
   */
  private _waitForDialog(id: number, timeout: number, signal: AbortSignal | undefined): Promise<Dialog | WaitEnd> {
    this._dialogWaiters.get(id)?.end('superseded');
    return new Promise<Dialog | WaitEnd>((resolve) => {
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
  }

  /** The failure of a dialog wait that ended without a dialog, or null when it timed out (the tab still open). */
  private _dialogWaitRefusal(id: number, outcome: WaitEnd): Record<string, unknown> | null {
    if (outcome === 'closed' || !this._tabs.has(id)) {
      return { success: false, error: `Tab ${id} was closed while waiting for a dialog` };
    }
    if (outcome === 'superseded') {
      return { success: false, error: 'Replaced by a later fox_handle_dialog on the same tab; nothing was armed' };
    }
    if (outcome === 'cancelled') {
      return { success: false, error: 'Cancelled: the caller gave up on fox_handle_dialog; nothing was armed' };
    }
    return null;
  }

  /** No dialog came: settle the next one on the tab within ARM_TTL_MS the same way. */
  private _armDialog(id: number, action: DialogAction, promptText: string | undefined): Record<string, unknown> {
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
