import { loadConfig, getAuditLogPath, safetyConfigPath } from './config.js';
import type { LoadedSafetyConfig } from './config.js';
import { audit } from './audit.js';
import type { AuditDecision } from './audit.js';
import { checkHeadlessContainerScope } from './container.js';
import { NEW_TAB_URL, grantCoversDenial } from './approval.js';
import type { ApprovalGrant } from './approval.js';
import { PATTERN_LIST_KEYS, compileUrlPatterns, normalizeUrl } from './url-pattern.js';
import type { PatternListName, UrlPattern } from './url-pattern.js';
import {
  ACTING_TOOLS,
  PAGE_READ_TOOLS,
  TAB_INDEPENDENT_TOOLS,
  isOperationIn,
} from '../tools/classification.js';
import { SAFETY_STATUS_TOOL, navigateGoesToUrl } from '../tools/schemas.js';
import { isRecord } from '@inari-mcp/shared';

// Derived from the tool schemas; re-exported for the existing importers.
export { ACTING_TOOLS, PAGE_READ_TOOLS, TAB_INDEPENDENT_TOOLS };

/**
 * The URL a call goes to or opens, or null when it acts on (or reads) a tab
 * as it is. fox_wait_for_url's `url` is only the URL it waits for, and
 * fox_navigate goes to its `url` only for goto (navigateGoesToUrl): a `url`
 * given to back / forward / refresh would otherwise stand in for the tab's
 * real URL. The guard's pre-check and the URL rules handlers.ts attaches
 * for the Extension's own check both decide by this function.
 */
export function targetUrlOf(toolName: string, args: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'fox_wait_for_url':
      return null;
    case 'fox_navigate':
      if (!navigateGoesToUrl(args['action'])) return null;
      break;
    default:
      break;
  }
  const url = args['url'];
  return typeof url === 'string' && url !== '' ? url : null;
}

/**
 * Calls that open a new tab, whose id the result may not report. fox_navigate
 * opens one only for goto: back / forward / refresh with `newTab: true` act
 * on the tab as it is, and are approved for its page.
 */
function opensNewTab(toolName: string | undefined, args: Record<string, unknown>): boolean {
  switch (toolName) {
    case 'fox_create_tab':
    case 'fox_open_in_container':
      return true;
    case 'fox_navigate':
      return navigateGoesToUrl(args['action']) && args['newTab'] === true;
    default:
      return false;
  }
}

/**
 * The layers of the safety model, as reported in `details.layer` of a
 * refusal. 6 is unused: it was the script-execution switch, removed with the
 * script tools. The numbers are not closed up, so a `details.layer` keeps
 * its meaning.
 */
export const LAYER = {
  containerScope: 0,
  rateLimit: 1,
  scheme: 2,
  lists: 3,
  readSites: 4,
  readOnly: 5,
  approval: 7,
} as const;
export type Layer = (typeof LAYER)[keyof typeof LAYER];

/**
 * How a call is named in messages and in the audit log, when that differs
 * from the operation the guard checks: a public tool such as fox_tab runs
 * the operation fox_close_tab (tools/operations.ts).
 */
export interface CallLabel {
  /** The tool name the caller used (messages, elicitation). */
  tool: string;
  /** The arguments as called (audit log). */
  args: Record<string, unknown>;
  /**
   * Set when `tool` is a deprecated name: the tool that replaces it. The
   * audit log records this as `tool` and the deprecated name as `legacyTool`.
   */
  replacedBy?: string;
  /**
   * With replacedBy: `args` in the form the replacing tool takes them
   * (discriminator included), so the audit log shows a call the same way
   * whichever name it was made by. `args` stays as called (approvals).
   */
  auditArgs?: Record<string, unknown>;
}

/** The decisions a denial carries: those of the audit log that refuse. */
export type DenialDecision = Exclude<
  AuditDecision,
  'allowed' | 'allowed_by_human' | 'approval_granted' |
  'approval_denied' | 'denied' | 'browser_error'
>;

/**
 * The layer each refusal belongs to. A config error is in no layer: the
 * whole policy could not be used, and every tool is refused. Nor is a pause:
 * the user's switch in the toolbar popup, not a rule of the policy.
 */
export const LAYER_OF: Readonly<Record<DenialDecision, Layer | null>> = {
  config_error: null,
  paused: null,
  out_of_scope: LAYER.containerScope,
  rate_limited: LAYER.rateLimit,
  blocked_scheme: LAYER.scheme,
  invalid_url: LAYER.scheme,
  blocked_url: LAYER.lists,
  not_allowlisted: LAYER.lists,
  blocked_after_navigation: LAYER.lists,
  read_only: LAYER.readOnly,
  // Layer 7 (acting tools). A read on a confirm_read_sites site reports
  // Layer 4 in its own denial (_readSiteConfirmation).
  confirmation_required: LAYER.approval,
};

export interface SafetyDenial {
  success: false;
  safetyDecision: DenialDecision;
  /** details.layer of the tool result (LAYER_OF). */
  layer: Layer | null;
  error: string;
  /** The URL the denial is about, when it names one (details.url of the tool result). */
  url?: string;
  confirmationRequired?: true;
  /** What the human is asked to approve (confirmation_required only). */
  elicitation?: {
    /** The URL the call acts on or reads; null when the guard does not know the tab's page. */
    url: string | null;
    /** The confirm_read_sites entry of a read; null for an acting tool. */
    matchedPattern: string | null;
    toolName: string;
  };
}

/** A confirmation_required refusal of the browser, as confirmationFromBrowser() reads it. */
export interface BrowserConfirmation {
  /** The target tab's URL if the browser reported it (`data.url`); also recorded like noteUrl(). */
  url: string | null;
  /** The confirm_read_sites entry the browser matched (`data.matchedPattern`), if reported. */
  matchedPattern?: string | null;
  transport?: string;
  label?: CallLabel;
}

/** One call as the layers of SafetyGuard._checkInner() see it. */
interface CheckedCall {
  toolName: string;
  args: Record<string, unknown>;
  /** The tool name the caller used (messages, elicitation). */
  shown: string;
  /** The URL the call goes to or opens (targetUrlOf), or null. */
  targetUrl: string | null;
  /** The target tab's last-known URL, or null. */
  currentUrl: string | null;
}

export interface SafetyStatus {
  success: true;
  enabled: boolean;
  /** Set when safety.json could not be used; every tool is refused. */
  configError: string | null;
  /** Non-fatal pattern problems (legacy regex patterns etc.). */
  patternWarnings: string[];
  readOnly: boolean;
  /** Which calls ask the human first (APPROVAL_POLICY). */
  approvalPolicy: string;
  allowPasswordTyping: boolean;
  maxActionsPerMinute: number;
  actionsInLastMinute: number;
  /** Last URL seen on the active tab (commands without tabId). */
  currentUrl: string | null;
  blockedUrlPatterns: string[];
  allowedUrlPatterns: string[];
  confirmReadSites: string[];
  configFile: string;
  auditLog: string | null;
}

/** fox_safety_status `approvalPolicy`: fixed, not a setting. */
export const APPROVAL_POLICY =
  'Every acting tool (click, type, set value, select, key press, navigation, opening and ' +
  'closing tabs, container tabs, dialogs) asks the human before it runs, on every site, once ' +
  'per call. Reading, waiting and UI-only tools run without asking, except reads and ' +
  'screenshots of sites in confirm_read_sites.';

/** The window of max_actions_per_minute. */
const RATE_WINDOW_MS = 60_000;

function isHttp(url: string): boolean {
  const n = normalizeUrl(url);
  return n !== null && (n.url.protocol === 'http:' || n.url.protocol === 'https:');
}

/**
 * A page without a host other than about: and file: (view-source:, blob:,
 * data:, ...). about: pages (about:blank, a new tab) and local files are no
 * site's pages; the others may show or carry one, under a URL no pattern
 * can match.
 */
function isHostlessPage(url: string): boolean {
  const n = normalizeUrl(url);
  return n !== null && n.hostname === '' && n.url.protocol !== 'about:' && n.url.protocol !== 'file:';
}

export class SafetyGuard {
  readonly config: LoadedSafetyConfig;
  private _actionTimes: number[] = [];
  /** Last URL seen per tab id. */
  private _tabUrls = new Map<number, string>();
  /** Last URL seen on the active tab, the target of commands without tabId. */
  private _activeUrl: string | null = null;
  private _activeTabId: number | null = null;
  private _blocked: UrlPattern[] = [];
  private _allowed: UrlPattern[] = [];
  private _confirmRead: UrlPattern[] = [];
  private _configError: string | null = null;
  private _patternWarnings: string[] = [];

  constructor(config?: LoadedSafetyConfig) {
    this.config = config ?? loadConfig();
    this._configError = this.config.configError ?? null;
    this._compilePatterns();
  }

  /** Set when the policy cannot be used: check() then refuses every tool. */
  get configError(): string | null {
    return this._configError;
  }

  /**
   * @param grant  A consumed human-approval token for this exact call
   *               (safety/approval.ts). It lifts only a Layer 4/7
   *               `confirmation_required` for the approved site; every other
   *               denial stands. A call the grant let through is audited
   *               as `allowed_by_human`; a grant that lifts nothing
   *               changes nothing.
   */
  check(
    toolName: string,
    args: Record<string, unknown>,
    transport?: string,
    grant?: ApprovalGrant | null,
    label?: CallLabel,
  ): SafetyDenial | null {
    const shown = label?.tool ?? toolName;
    const targetUrl = targetUrlOf(toolName, args);
    const currentUrl = this.urlFor(this._tabIdArg(args));

    // Fail closed: a policy that could not be loaded refuses everything,
    // whatever its `enabled` flag says.
    if (this._configError !== null) {
      this.recordAudit(toolName, args, 'config_error', transport, label, targetUrl ?? currentUrl);
      return this._deny(
        'config_error',
        `${shown} refused: the safety config cannot be used (${this._configError}). ` +
        'Every tool is refused until it is fixed and the InariMCP daemon restarted. ' +
        'fox_safety_status shows the error.',
      );
    }

    // Off, the guard asks nothing; the human approval stays: the Extension
    // and the headless backend refuse every acting command that carries no
    // approval for its site (headless/approval-floor.ts).
    if (!this.config.enabled) {
      return null;
    }

    const inner = this._checkInner(toolName, targetUrl, currentUrl, args, shown);
    // The grant counts only when it lifts this very denial: a grant for
    // another host, or for a call that needed none, changes nothing.
    const liftedByHuman = grantCoversDenial(inner, grant);
    let denial = liftedByHuman ? null : inner;

    // Layer 1: Rate limit, checked last so that only calls that would run
    // count: refused calls and fox_safety_status do not use up the budget.
    if (denial === null && toolName !== SAFETY_STATUS_TOOL && !this._withinRateLimit()) {
      denial = this._deny(
        'rate_limited',
        `Rate limit exceeded: more than ${this.config.maxActionsPerMinute} actions ` +
        'in the last minute. Wait a few seconds and retry.',
      );
    }

    let decision: AuditDecision;
    if (denial !== null) {
      decision = denial.safetyDecision;
    } else if (liftedByHuman) {
      decision = 'allowed_by_human';
    } else {
      decision = 'allowed';
    }

    this.recordAudit(toolName, args, decision, transport, label, targetUrl ?? currentUrl);
    return denial;
  }

  /**
   * Check the URL a successful command reports it ended on (`data.url`,
   * else `data.tab.url`) against blocked/allowed_url_patterns. A redirect,
   * a click on a link or a history step can reach a URL the pre-check never
   * saw; the browser has already gone there, so the result is withheld
   * instead. Call after noteUrl(), so later commands on that tab are refused
   * by the pre-check as well.
   */
  checkReachedUrl(
    toolName: string,
    args: Record<string, unknown>,
    result: Record<string, unknown>,
    transport?: string,
    label?: CallLabel,
  ): SafetyDenial | null {
    if (this._configError !== null || !this.config.enabled) return null;
    const url = this._reportedUrl(result);
    if (url === null) return null;
    const violation = this._listViolation(url);
    if (violation === null) return null;

    this.recordAudit(toolName, args, 'blocked_after_navigation', transport, label, url);
    return this._deny(
      'blocked_after_navigation',
      `${label?.tool ?? toolName} ended on '${url}', which ${violation.reason}. The result is withheld. ` +
      'Navigate the tab elsewhere (fox_navigate with a url) or close it.',
      url,
    );
  }

  /**
   * Record the URL a result reports, for the tab it belongs to: the
   * reported tab id (`data.tabId`, `data.tab.id`), else the `tabId`
   * argument. Commands without a `tabId` argument act on the active tab.
   * A `tabs` list (fox_get_tabs) refreshes every listed tab.
   *
   * A backend reports `url` and `tabId` at the top level of a result
   * whenever it knows them: a click on a link or a redirect moves the tab,
   * and only the result says where to.
   */
  noteUrl(
    result: Record<string, unknown>,
    args: Record<string, unknown> = {},
    toolName?: string,
  ): void {
    this._noteTabsList(result['tabs']);

    const explicitTabId = this._tabIdArg(args);
    if (toolName === 'fox_close_tab') {
      this._noteClosed(result, explicitTabId);
      return;
    }

    const url = this._reportedUrl(result);
    if (url === null) return;

    // A new tab is not the tab the tabId argument names (fox_navigate
    // newTab with a tabId): only the id the result reports is its own.
    const reportedTabId = this._reportedTabId(result);
    const tabId = opensNewTab(toolName, args) ? reportedTabId : reportedTabId ?? explicitTabId;
    if (tabId !== undefined) this._tabUrls.set(tabId, url);
    if (!this._becomesActive(toolName, args, explicitTabId)) return;

    // A result without a tab id is still about the active tab when the call
    // acted on it: keep the id known so far (fox_get_tabs, an earlier
    // result), so that a later call with that tabId sees this URL. Only a
    // new tab has an id nobody knows yet.
    const activeId = tabId ?? (opensNewTab(toolName, args) ? null : this._activeTabId);
    this._activeUrl = url;
    this._activeTabId = activeId;
    if (activeId !== null) this._tabUrls.set(activeId, url);
  }

  /**
   * Record where the target tab of a refused call is, as the browser
   * reported it: the `tabId` argument, else the active tab. Unlike
   * noteUrl(), nothing was closed, opened or switched (a refused
   * fox_close_tab leaves the tab open).
   */
  noteRefusedUrl(url: string, args: Record<string, unknown> = {}): void {
    const explicitTabId = this._tabIdArg(args);
    if (explicitTabId === undefined) {
      this._activeUrl = url;
      if (this._activeTabId !== null) this._tabUrls.set(this._activeTabId, url);
      return;
    }
    this._tabUrls.set(explicitTabId, url);
    if (explicitTabId === this._activeTabId) this._activeUrl = url;
  }

  /** fox_get_tabs: every listed tab, and the active one when unambiguous. */
  private _noteTabsList(tabs: unknown): void {
    if (!Array.isArray(tabs)) return;
    const active: Array<{ id: number; url: string }> = [];
    for (const tab of tabs) {
      if (isRecord(tab) && typeof tab['id'] === 'number' && typeof tab['url'] === 'string') {
        this._tabUrls.set(tab['id'], tab['url']);
        if (tab['active'] === true) active.push({ id: tab['id'], url: tab['url'] });
      }
    }
    // One active tab per window: only an unambiguous list names "the" active tab.
    if (active.length === 1) {
      this._activeTabId = active[0].id;
      this._activeUrl = active[0].url;
    }
  }

  /**
   * fox_close_tab: forget the tab the backend reports it closed (`closed`;
   * headless also `closedTabId`), else the tabId argument.
   */
  private _noteClosed(result: Record<string, unknown>, explicitTabId: number | undefined): void {
    const closedId =
      typeof result['closed'] === 'number' ? result['closed']
        : typeof result['closedTabId'] === 'number' ? result['closedTabId']
          : explicitTabId;
    if (closedId === undefined) return;
    this._tabUrls.delete(closedId);
    if (this._activeTabId === closedId) {
      this._activeTabId = null;
      this._activeUrl = null;
    }
  }

  /** The tab id a result reports (`tabId`, else `tab.id`). */
  private _reportedTabId(result: Record<string, unknown>): number | undefined {
    if (typeof result['tabId'] === 'number') return result['tabId'];
    const tab = result['tab'];
    return isRecord(tab) && typeof tab['id'] === 'number' ? tab['id'] : undefined;
  }

  /** Whether the tab a result is about is the active tab afterwards. */
  private _becomesActive(
    toolName: string | undefined,
    args: Record<string, unknown>,
    explicitTabId: number | undefined,
  ): boolean {
    // A call without tabId acts on the active tab, except a tab opened in the background.
    switch (toolName) {
      case 'fox_switch_tab':
        // It activates the tab it names.
        return true;
      case 'fox_create_tab':
      case 'fox_open_in_container':
        if (explicitTabId === undefined) return args['active'] !== false;
        break;
      default:
        if (explicitTabId === undefined) return true;
        break;
    }
    // A call that names the active tab by its id.
    return explicitTabId === this._activeTabId;
  }

  /** Last URL seen on the given tab, or on the active tab when undefined. */
  urlFor(tabId?: number): string | null {
    if (tabId === undefined) return this._activeUrl;
    return this._tabUrls.get(tabId) ?? (tabId === this._activeTabId ? this._activeUrl : null);
  }

  /**
   * Build the confirmation result for a refusal the browser made itself
   * (safetyDecision "confirmation_required"): the actual target tab of an
   * acting tool is on a site the call was not approved for (the Extension
   * and the headless backend require an approval for every acting command),
   * or a read's target tab matched the `confirmReadUrlRules` attached to the
   * command. The server could not have known when its last-known URL for the
   * tab was stale or unknown.
   */
  confirmationFromBrowser(
    toolName: string,
    args: Record<string, unknown>,
    reported: BrowserConfirmation,
  ): SafetyDenial {
    const shown = reported.label?.tool ?? toolName;
    if (reported.url) this.noteRefusedUrl(reported.url, args);
    const knownUrl = reported.url ?? this.urlFor(this._tabIdArg(args));
    this.recordAudit(toolName, args, 'confirmation_required', reported.transport, reported.label, knownUrl);

    const page = knownUrl ?? '(target tab)';
    if (isOperationIn(ACTING_TOOLS, toolName)) {
      return this._confirmation(
        LAYER.approval,
        { url: knownUrl, matchedPattern: null, toolName: shown },
        `${shown} needs human approval for '${page}', where the browser reports the target ` +
        'tab is. Every acting tool asks the human first, on every site.',
      );
    }

    const matched = this._matchedReadSite(knownUrl) ?? reported.matchedPattern ?? null;
    return this._confirmation(
      LAYER.readSites,
      { url: knownUrl, matchedPattern: matched, toolName: shown },
      `${shown} reads '${page}', which matches confirm_read_sites entry '${matched ?? '?'}' ` +
      'in safety.json (as checked by the browser). Reading this site needs human approval.',
    );
  }

  /**
   * One audit log line, when audit_log is on, under the caller's names
   * (CallLabel), else the operation's. `url` left out (undefined) defaults
   * to the call's target URL, else the target tab's last-known URL (what
   * check() records); null records a line without a URL.
   */
  recordAudit(
    toolName: string,
    args: Record<string, unknown>,
    decision: AuditDecision,
    transport?: string,
    label?: CallLabel,
    url: string | null = targetUrlOf(toolName, args) ?? this.urlFor(this._tabIdArg(args)),
  ): void {
    if (!this.config.auditLog) return;
    if (label === undefined) {
      audit(toolName, args, url, decision, transport);
    } else if (label.replacedBy !== undefined) {
      audit(label.replacedBy, label.auditArgs ?? label.args, url, decision, transport, label.tool);
    } else {
      audit(label.tool, label.args, url, decision, transport);
    }
  }

  status(): SafetyStatus {
    return {
      success: true,
      enabled: this.config.enabled,
      configError: this._configError,
      patternWarnings: [...this._patternWarnings],
      readOnly: this.config.readOnly,
      approvalPolicy: APPROVAL_POLICY,
      allowPasswordTyping: this.config.allowPasswordTyping,
      maxActionsPerMinute: this.config.maxActionsPerMinute,
      actionsInLastMinute: this._actionTimes.length,
      currentUrl: this._activeUrl,
      blockedUrlPatterns: this.config.blockedUrlPatterns,
      allowedUrlPatterns: this.config.allowedUrlPatterns,
      confirmReadSites: this.config.confirmReadSites,
      // The file loadConfig() read: a blank setting counts as unset.
      configFile: safetyConfigPath(),
      auditLog: this.config.auditLog ? getAuditLogPath() : null,
    };
  }

  /**
   * The layers of check() that refuse or ask, in order: Layer 0 and 2-3 for
   * every call, then Layer 4 for a call that changes no page data, or
   * Layer 2 (a page without a host), 5 and 7 for an acting call.
   */
  private _checkInner(
    toolName: string,
    targetUrl: string | null,
    currentUrl: string | null,
    args: Record<string, unknown>,
    shown: string,
  ): SafetyDenial | null {
    const call: CheckedCall = { toolName, args, shown, targetUrl, currentUrl };
    // The layers that apply to every call.
    const earlyDenial = this._checkContainerScope() ?? this._checkUrlRules(call);
    if (earlyDenial !== null) return earlyDenial;
    if (!isOperationIn(ACTING_TOOLS, toolName)) return this._checkReading(call);

    return this._checkActing(call);
  }

  /**
   * Layer 0: Container scope (server-side part only).
   * The server cannot see tabs, so the per-tab cookieStoreId check is done
   * by the Extension using the `containerScope` that handlers.ts attaches
   * to every BrowserCommand. Here we only refuse everything when the
   * backend has no containers at all (headless).
   */
  private _checkContainerScope(): SafetyDenial | null {
    const containerDenial = checkHeadlessContainerScope(this.config);
    return containerDenial ? this._deny(containerDenial.safetyDecision, containerDenial.error) : null;
  }

  /**
   * Layer 2-3: URL scheme guard + blocklist/allowlist, on the parsed URL the
   * call goes to, else on the target tab's last-known URL.
   */
  private _checkUrlRules({ toolName, shown, targetUrl, currentUrl }: CheckedCall): SafetyDenial | null {
    if (targetUrl !== null) return this._checkTargetUrl(targetUrl);
    if (currentUrl === null || isOperationIn(TAB_INDEPENDENT_TOOLS, toolName)) return null;

    // No url argument: the tool acts on (or reads) the tab, whose last
    // known URL may have been reached by a redirect or a click.
    const violation = this._listViolation(currentUrl);
    if (violation === null) return null;
    return this._deny(
      violation.decision,
      `${shown} refused: the target tab is on '${currentUrl}', which ${violation.reason}. ` +
      'Navigate it elsewhere (fox_navigate with a url) or close it.',
      currentUrl,
    );
  }

  /** Layer 2-3 for the URL a call goes to or opens. */
  private _checkTargetUrl(targetUrl: string): SafetyDenial | null {
    const n = normalizeUrl(targetUrl);
    if (n === null) {
      return this._deny(
        'invalid_url',
        `'${targetUrl}' refused: not an absolute URL (e.g. https://example.com/).`,
      );
    }
    const isBlank = n.url.href === 'about:blank';
    if (!isBlank && n.url.protocol !== 'http:' && n.url.protocol !== 'https:') {
      return this._deny(
        'blocked_scheme',
        `Navigation to '${targetUrl}' refused: only http://, https:// and about:blank targets are allowed.`,
      );
    }
    if (n.hasUserinfo) {
      return this._deny(
        'invalid_url',
        `'${targetUrl}' refused: URLs with a user name or password before the host ` +
        "('user:pass@host') are not allowed; they hide the real host.",
      );
    }

    const violation = this._listViolation(targetUrl);
    if (violation === null) return null;
    return this._deny(violation.decision, `URL '${targetUrl}' ${violation.reason}.`, targetUrl);
  }

  /**
   * Layer 4: tools that change no page data (read, wait, UI only) run
   * without approval; a read of a tab on a confirm_read_sites site asks
   * the human. scope all_tabs is handled by the Extension, which skips
   * such tabs.
   */
  private _checkReading({ toolName, args, shown, targetUrl, currentUrl }: CheckedCall): SafetyDenial | null {
    const capturesAllTabs = toolName === 'fox_screenshot' && args['scope'] === 'all_tabs';
    if (!isOperationIn(PAGE_READ_TOOLS, toolName) || capturesAllTabs) return null;
    return this._readSiteConfirmation(shown, targetUrl ?? currentUrl);
  }

  /** The layers of an acting tool: 2 (a page without a host), 5 and 7. */
  private _checkActing(call: CheckedCall): SafetyDenial | null {
    const { toolName, shown, targetUrl, currentUrl } = call;
    // Layer 2 for acting tools: a tab on a page without a host
    // (view-source:, blob:, data:, ...) matches no URL pattern, and a Layer 7
    // approval could name only its scheme, not the site it shows or carries.
    // Acting there is refused; the reading tools stay allowed.
    if (targetUrl === null && currentUrl !== null && !isOperationIn(TAB_INDEPENDENT_TOOLS, toolName) &&
      isHostlessPage(currentUrl)) {
      return this._deny(
        'blocked_scheme',
        `${shown} refused: the target tab is on '${currentUrl}', a page without a host ` +
        '(such as view-source:, blob: or data:), where only reading tools are allowed. ' +
        'Navigate it to an http(s) URL (fox_navigate with a url) first.',
        currentUrl,
      );
    }

    // Layer 5: Read-only mode
    if (this.config.readOnly) {
      return this._deny(
        'read_only',
        `${shown} refused: safety guard is in read-only mode ` +
        '(readOnly in safety.json or FOX_READ_ONLY=1). ' +
        'Observation tools like fox_screenshot remain available.',
      );
    }

    // Layer 7: every acting tool asks the human, on every site.
    return this._actionConfirmation(shown, this._approvalUrl(call));
  }

  /**
   * The URL an acting call is approved for: the URL it goes to or opens,
   * about:blank for a new tab without one, else the target tab's last-known
   * URL (null when the guard has not seen it).
   */
  private _approvalUrl({ toolName, args, targetUrl, currentUrl }: CheckedCall): string | null {
    if (targetUrl !== null) return targetUrl;
    if (opensNewTab(toolName, args)) return NEW_TAB_URL;
    return currentUrl;
  }

  /** A confirmation_required denial: what the human is asked to approve, and why. */
  private _confirmation(
    layer: Layer,
    elicitation: NonNullable<SafetyDenial['elicitation']>,
    error: string,
  ): SafetyDenial {
    return { success: false, safetyDecision: 'confirmation_required', layer, confirmationRequired: true, elicitation, error };
  }

  /**
   * Layer 7: an acting tool needs a human approval (MCP elicitation or the
   * Extension's popup) for the site of `url`. With `url` null the guard does
   * not know the target tab's page, so the call cannot be approved yet
   * (tools/handlers.ts tells the caller to list the tabs first).
   * `shown`: the tool name the caller used (messages, elicitation).
   *
   * The approval names a site, not who gave it: an elicitation answer
   * reaches the daemon over local HTTP, so a local process that can read the
   * API token can answer for itself (README, Human approval). The floor of
   * the Extension and of the headless backend checks only that a command
   * runs on the approved site.
   */
  private _actionConfirmation(shown: string, url: string | null): SafetyDenial {
    const page = url !== null ? ` for '${url}'` : '';
    return this._confirmation(
      LAYER.approval,
      { url, matchedPattern: null, toolName: shown },
      `${shown} needs human approval${page}. ` +
      'Every acting tool (input, navigation, tabs) asks the human first, on every site.',
    );
  }

  /**
   * Layer 4: a read of a tab whose URL (`checkUrl`: the target URL, or the
   * tab's last-known URL) matches confirm_read_sites needs human approval.
   * Null when it does not match or the URL is unknown (the Extension then
   * checks the real tab with the attached confirmReadUrlRules).
   */
  private _readSiteConfirmation(shown: string, checkUrl: string | null): SafetyDenial | null {
    const matched = this._matchedReadSite(checkUrl);
    if (checkUrl === null || matched === null) return null;
    return this._confirmation(
      LAYER.readSites,
      { url: checkUrl, matchedPattern: matched, toolName: shown },
      `${shown} reads '${checkUrl}', which matches confirm_read_sites entry '${matched}' ` +
      'in safety.json. Reading this site needs human approval.',
    );
  }

  /**
   * Whether `url` violates blocked/allowed_url_patterns, or null. Only
   * http(s) URLs are subject to the lists; about:blank and browser-internal
   * pages are not sites.
   */
  private _listViolation(
    url: string,
  ): { decision: 'blocked_url' | 'not_allowlisted'; reason: string } | null {
    if (!isHttp(url)) return null;
    const blocked = this._blocked.find((p) => p.test(url));
    if (blocked) {
      return {
        decision: 'blocked_url',
        reason: `matches blocked_url_patterns entry '${blocked.source}' in safety.json`,
      };
    }
    if (this.config.allowedUrlPatterns.length > 0 && !this._allowed.some((p) => p.test(url))) {
      return {
        decision: 'not_allowlisted',
        reason: 'does not match allowed_url_patterns in safety.json (allowlist mode is active)',
      };
    }
    return null;
  }

  private _tabIdArg(args: Record<string, unknown>): number | undefined {
    const tabId = args['tabId'];
    return typeof tabId === 'number' ? tabId : undefined;
  }

  private _reportedUrl(result: Record<string, unknown>): string | null {
    const url = result['url'];
    if (typeof url === 'string' && url) return url;
    const tab = result['tab'];
    if (isRecord(tab) && typeof tab['url'] === 'string' && tab['url']) return tab['url'];
    return null;
  }

  private _matchedReadSite(url: string | null): string | null {
    if (!url) return null;
    for (const pattern of this._confirmRead) {
      if (pattern.test(url)) return pattern.source;
    }
    return null;
  }

  private _withinRateLimit(): boolean {
    const limit = this.config.maxActionsPerMinute;
    if (!limit || limit <= 0) return true;

    const now = Date.now();
    const cutoff = now - RATE_WINDOW_MS;

    while (this._actionTimes.length > 0 && this._actionTimes[0] <= cutoff) {
      this._actionTimes.shift();
    }

    if (this._actionTimes.length >= limit) {
      return false;
    }

    this._actionTimes.push(now);
    return true;
  }

  private _deny(decision: DenialDecision, message: string, url?: string): SafetyDenial {
    return {
      success: false,
      safetyDecision: decision,
      layer: LAYER_OF[decision],
      error: message,
      ...(url !== undefined ? { url } : {}),
    };
  }

  private _compilePatterns(): void {
    const errors: string[] = [];
    const compile = (sources: string[], list: PatternListName): UrlPattern[] => {
      const { patterns, issues } = compileUrlPatterns(sources, list);
      for (const issue of issues) {
        const line = `${PATTERN_LIST_KEYS[list]} '${issue.pattern}': ${issue.message}`;
        if (issue.fatal) {
          errors.push(line);
        } else {
          this._patternWarnings.push(line);
          process.stderr.write(`[InariMCP] safety.json ${line}\n`);
        }
      }
      return patterns;
    };
    this._blocked = compile(this.config.blockedUrlPatterns, 'blocked');
    this._allowed = compile(this.config.allowedUrlPatterns, 'allowed');
    this._confirmRead = compile(this.config.confirmReadSites, 'confirmRead');

    // An unusable pattern must not silently narrow the policy (a dropped
    // blocked entry, an allowlist that loses its only entry): fail closed.
    if (errors.length > 0 && this._configError === null) {
      this._configError = `invalid URL patterns: ${errors.join('; ')}`;
      process.stderr.write(
        `[InariMCP] WARNING: ${this._configError}. The safety guard refuses every tool.\n`,
      );
    }
  }
}

let _guard: SafetyGuard | null = null;

export function getSafetyGuard(): SafetyGuard {
  if (_guard === null) {
    _guard = new SafetyGuard();
  }
  return _guard;
}
