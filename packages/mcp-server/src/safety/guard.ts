import { loadConfig, getAuditLogPath } from './config.js';
import type { LoadedSafetyConfig } from './config.js';
import { audit } from './audit.js';
import type { AuditDecision } from './audit.js';
import { checkHeadlessContainerScope } from './container.js';
import { grantCoversDenial } from './approval.js';
import type { ApprovalGrant } from './approval.js';
import { compileUrlPatterns, normalizeUrl } from './url-pattern.js';
import type { PatternListName, UrlPattern } from './url-pattern.js';
import { OBSERVE_TOOLS, SCRIPT_TOOLS } from '../tools/classification.js';
import { isRecord } from '@kitsune-mcp/shared';

// Derived from the tool schemas; re-exported for the existing importers.
export { OBSERVE_TOOLS, SCRIPT_TOOLS };

/**
 * Tools that do not act on the content of a tab, so the blocked/allowed
 * check of the tab's last-known URL does not apply. fox_navigate with a
 * `url` and fox_close_tab stay usable to leave a tab that ended up on a
 * blocked site. handlers.ts attaches the blocked/allowed rules for the
 * Extension's own check by the same rule.
 */
export const TAB_INDEPENDENT_TOOLS: ReadonlySet<string> = new Set([
  'fox_get_tabs',
  'fox_create_tab',
  'fox_close_tab',
  'fox_switch_tab',
  'fox_list_containers',
  'fox_open_in_container',
  'fox_safety_status',
]);

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
}

export interface SafetyDenial {
  success: false;
  safetyDecision: string;
  error: string;
  /** The URL the denial is about, when it names one (details.url of the tool result). */
  url?: string;
  confirmationRequired?: true;
  elicitation?: {
    protectedUrl: string;
    matchedPattern: string;
    toolName: string;
  };
}

export interface SafetyStatus {
  success: true;
  enabled: boolean;
  /** Set when safety.json could not be used; every tool is refused. */
  configError: string | null;
  /** Non-fatal pattern problems (legacy regex patterns etc.). */
  patternWarnings: string[];
  readOnly: boolean;
  allowScriptExecution: boolean;
  confirmProtectedActions: boolean;
  allowPasswordTyping: boolean;
  maxActionsPerMinute: number;
  actionsInLastMinute: number;
  /** Last URL seen on the active tab (commands without tabId). */
  currentUrl: string | null;
  blockedUrlPatterns: string[];
  allowedUrlPatterns: string[];
  protectedUrlPatterns: string[];
  configFile: string;
  auditLog: string | null;
}

function isHttp(url: string): boolean {
  const n = normalizeUrl(url);
  return n !== null && (n.url.protocol === 'http:' || n.url.protocol === 'https:');
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
  private _protected: UrlPattern[] = [];
  private _configError: string | null = null;
  private _patternWarnings: string[] = [];

  constructor(config?: LoadedSafetyConfig) {
    this.config = config ?? loadConfig();
    this._configError = this.config.configError ?? null;
    this._compilePatterns();
  }

  /**
   * @param grant  A consumed human-approval token for this exact call
   *               (safety/approval.ts). It lifts only a Layer 4/7
   *               `confirmation_required` for the approved host; every other
   *               denial stands. Decisions made with a grant are audited as
   *               `allowed_by_human`.
   */
  check(
    toolName: string,
    args: Record<string, unknown>,
    transport?: string,
    grant?: ApprovalGrant | null,
    label?: CallLabel,
  ): SafetyDenial | null {
    const shown = label?.tool ?? toolName;
    const targetUrl = this._targetUrl(toolName, args);
    const currentUrl = this.urlFor(this._tabIdArg(args));

    // Fail closed: a policy that could not be loaded refuses everything,
    // whatever its `enabled` flag says.
    if (this._configError !== null) {
      if (this.config.auditLog) {
        this._audit(toolName, args, targetUrl ?? currentUrl, 'config_error', transport, label);
      }
      return this._deny(
        'config_error',
        `${shown} refused: the safety config cannot be used (${this._configError}). ` +
        'Every tool is refused until it is fixed and the KitsuneMCP daemon restarted. ' +
        'fox_safety_status shows the error.',
      );
    }

    if (!this.config.enabled) {
      return null;
    }

    let denial = this._checkInner(toolName, targetUrl, currentUrl, args, shown);
    if (grantCoversDenial(denial, grant)) denial = null;

    // Layer 1: Rate limit, checked last so that only calls that would run
    // count: refused calls and fox_safety_status do not use up the budget.
    if (denial === null && toolName !== 'fox_safety_status' && !this._withinRateLimit()) {
      denial = this._deny(
        'rate_limited',
        `Rate limit exceeded: more than ${this.config.maxActionsPerMinute} actions ` +
        'in the last minute. Wait a few seconds and retry.',
      );
    }

    const isObserve = OBSERVE_TOOLS.has(toolName);
    let decision: AuditDecision;
    if (denial === null && grant) {
      decision = 'allowed_by_human';
    } else if (denial === null) {
      if (isObserve && this._matchedProtected(targetUrl ?? currentUrl) !== null) {
        decision = 'observed_on_protected_domain';
      } else {
        decision = 'allowed';
      }
    } else {
      decision = denial.safetyDecision as AuditDecision;
    }

    if (this.config.auditLog) {
      this._audit(toolName, args, targetUrl ?? currentUrl, decision, transport, label);
    }

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

    if (this.config.auditLog) {
      this._audit(toolName, args, url, 'blocked_after_navigation', transport, label);
    }
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
   */
  noteUrl(
    result: Record<string, unknown>,
    args: Record<string, unknown> = {},
    toolName?: string,
  ): void {
    const tabs = result['tabs'];
    if (Array.isArray(tabs)) {
      const active: Array<{ id: number; url: string }> = [];
      for (const tab of tabs) {
        if (isRecord(tab) && typeof tab['id'] === 'number' && typeof tab['url'] === 'string') {
          this._tabUrls.set(tab['id'], tab['url']);
          if (tab['active'] === true) active.push({ id: tab['id'], url: tab['url'] });
        }
      }
      // One active tab per window: only an unambiguous list names "the" active tab.
      if (active.length === 1) {
        this._activeTabId = active[0]!.id;
        this._activeUrl = active[0]!.url;
      }
    }

    const explicitTabId = this._tabIdArg(args);
    if (toolName === 'fox_close_tab') {
      // The tab the backend reports it closed (`closed`; headless also
      // `closedTabId`), else the tabId argument.
      const closedId =
        typeof result['closed'] === 'number' ? result['closed']
          : typeof result['closedTabId'] === 'number' ? result['closedTabId']
            : explicitTabId;
      if (closedId !== undefined) {
        this._tabUrls.delete(closedId);
        if (this._activeTabId === closedId) {
          this._activeTabId = null;
          this._activeUrl = null;
        }
      }
      return;
    }

    const url = this._reportedUrl(result);
    if (url === null) return;

    const tab = isRecord(result['tab']) ? result['tab'] : undefined;
    const reportedTabId =
      typeof result['tabId'] === 'number' ? result['tabId']
        : typeof tab?.['id'] === 'number' ? tab['id']
          : undefined;
    const tabId = reportedTabId ?? explicitTabId;
    if (tabId !== undefined) this._tabUrls.set(tabId, url);

    const opensInBackground =
      (toolName === 'fox_create_tab' || toolName === 'fox_open_in_container') &&
      args['active'] === false;
    const becomesActive =
      toolName === 'fox_switch_tab' ||
      (explicitTabId === undefined && !opensInBackground) ||
      (explicitTabId !== undefined && explicitTabId === this._activeTabId);
    if (becomesActive) {
      this._activeUrl = url;
      this._activeTabId = tabId ?? null;
    }
  }

  /** Last URL seen on the given tab, or on the active tab when undefined. */
  urlFor(tabId?: number): string | null {
    if (tabId === undefined) return this._activeUrl;
    return this._tabUrls.get(tabId) ?? (tabId === this._activeTabId ? this._activeUrl : null);
  }

  /**
   * Build the Layer 7-shaped confirmation result for a refusal the Extension
   * made itself: the actual target tab of a capture or acting tool matched
   * the `protectedUrlPatterns` attached to the command (safetyDecision
   * "confirmation_required"). The server could not have caught this when
   * its last-known URL for the tab was stale or unknown.
   *
   * @param url  The protected tab's URL if the Extension reported it
   *             (`data.url`); also recorded like noteUrl().
   * @param matchedPattern  The pattern the Extension matched
   *             (`data.matchedPattern`), if reported.
   */
  confirmationFromBrowser(
    toolName: string,
    args: Record<string, unknown>,
    url: string | null,
    transport?: string,
    matchedPattern?: string | null,
    label?: CallLabel,
  ): SafetyDenial {
    const shown = label?.tool ?? toolName;
    if (url) this.noteUrl({ url }, args, toolName);
    const knownUrl = url ?? this.urlFor(this._tabIdArg(args));
    const protectedUrl = knownUrl ?? '(target tab)';
    const matched =
      this._matchedProtected(knownUrl) ||
      matchedPattern ||
      '(protected_url_patterns)';

    if (this.config.auditLog) {
      this._audit(toolName, args, knownUrl, 'confirmation_required', transport, label);
    }

    return {
      success: false,
      safetyDecision: 'confirmation_required',
      confirmationRequired: true,
      elicitation: { protectedUrl, matchedPattern: matched, toolName: shown },
      error:
        `${shown} targets a protected site ('${protectedUrl}' matches ` +
        `pattern '${matched}' in safety.json, as checked by the browser). ` +
        'This is a guard against unintended actions on, or captures of, sensitive ' +
        'sites (banking, payments, health, government). Human confirmation is ' +
        'required via MCP elicitation.',
    };
  }

  status(): SafetyStatus {
    return {
      success: true,
      enabled: this.config.enabled,
      configError: this._configError,
      patternWarnings: [...this._patternWarnings],
      readOnly: this.config.readOnly,
      allowScriptExecution: this.config.allowScriptExecution,
      confirmProtectedActions: this.config.confirmProtectedActions,
      allowPasswordTyping: this.config.allowPasswordTyping,
      maxActionsPerMinute: this.config.maxActionsPerMinute,
      actionsInLastMinute: this._actionTimes.length,
      currentUrl: this._activeUrl,
      blockedUrlPatterns: this.config.blockedUrlPatterns,
      allowedUrlPatterns: this.config.allowedUrlPatterns,
      protectedUrlPatterns: this.config.protectedUrlPatterns,
      configFile: process.env['FOX_SAFETY_CONFIG'] ??
        process.env['CLAUDE_BROWSER_SAFETY_CONFIG'] ??
        '~/.kitsune-mcp/safety.json',
      auditLog: this.config.auditLog ? getAuditLogPath() : null,
    };
  }

  private _checkInner(
    toolName: string,
    targetUrl: string | null,
    currentUrl: string | null,
    args: Record<string, unknown>,
    shown: string,
  ): SafetyDenial | null {
    const isObserve = OBSERVE_TOOLS.has(toolName);
    const isScript = SCRIPT_TOOLS.has(toolName);

    // Layer 0: Container scope (server-side part only).
    // The server cannot see tabs, so the per-tab cookieStoreId check is done
    // by the Extension using the `containerScope` that handlers.ts attaches
    // to every BrowserCommand. Here we only refuse everything when the
    // backend has no containers at all (headless).
    const containerDenial = checkHeadlessContainerScope(this.config);
    if (containerDenial) {
      return {
        success: false,
        safetyDecision: containerDenial.safetyDecision,
        error: containerDenial.error,
      };
    }

    // Layer 2-3: URL scheme guard + blocklist/allowlist, on the parsed URL
    if (targetUrl !== null) {
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
      if (violation !== null) {
        return this._deny(violation.decision, `URL '${targetUrl}' ${violation.reason}.`);
      }
    } else if (currentUrl !== null && !TAB_INDEPENDENT_TOOLS.has(toolName)) {
      // No url argument: the tool acts on (or reads) the tab, whose last
      // known URL may have been reached by a redirect or a click.
      const violation = this._listViolation(currentUrl);
      if (violation !== null) {
        return this._deny(
          violation.decision,
          `${shown} refused: the target tab is on '${currentUrl}', which ${violation.reason}. ` +
          'Navigate it elsewhere (fox_navigate with a url) or close it.',
        );
      }
    }

    // Layer 4: Observe tools pass through.
    // Exception: a single-tab fox_screenshot on a protected domain captures
    // sensitive page content, so it gets the same elicitation as Layer 7.
    // (scope all_tabs is handled Extension-side: protected tabs are excluded.)
    if (isObserve) {
      if (toolName === 'fox_screenshot' && args['scope'] !== 'all_tabs') {
        return this._protectedConfirmation(shown, targetUrl ?? currentUrl);
      }
      return null;
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

    // Layer 6: Script toggle
    if (isScript && !this.config.allowScriptExecution) {
      return this._deny(
        'scripts_disabled',
        `${shown} refused: script execution is disabled ` +
        '(allowScriptExecution in safety.json or FOX_ALLOW_SCRIPTS=0).',
      );
    }

    // Layer 7: Protected domain confirmation (MCP elicitation)
    return this._protectedConfirmation(shown, targetUrl ?? currentUrl);
  }

  /**
   * Layer 7: require human confirmation (MCP elicitation) when `checkUrl`
   * (the target URL, or the tab's last-known URL) matches
   * protected_url_patterns. No-op when confirmProtectedActions is false.
   * `shown`: the tool name the caller used (messages, elicitation).
   */
  private _protectedConfirmation(
    shown: string,
    checkUrl: string | null,
  ): SafetyDenial | null {
    if (!this.config.confirmProtectedActions) {
      return null;
    }
    if (checkUrl === null) {
      return null;
    }
    const matched = this._matchedProtected(checkUrl);
    if (!matched) {
      return null;
    }
    return {
      success: false,
      safetyDecision: 'confirmation_required',
      confirmationRequired: true,
      elicitation: {
        protectedUrl: checkUrl,
        matchedPattern: matched,
        toolName: shown,
      },
      error:
        `${shown} targets a protected site ('${checkUrl}' matches ` +
        `pattern '${matched}' in safety.json). This is a guard against ` +
        'unintended actions on sensitive sites (banking, payments, health, government). ' +
        'Human confirmation is required via MCP elicitation.',
    };
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

  /**
   * The URL a tool goes to or opens. fox_wait_for_url's `url` is only the
   * URL it waits for, so the tab's own URL is checked instead.
   */
  private _targetUrl(toolName: string, args: Record<string, unknown>): string | null {
    if (toolName === 'fox_wait_for_url') return null;
    const url = args['url'];
    return typeof url === 'string' && url ? url : null;
  }

  /** audit() under the caller's names (CallLabel), else the operation's. */
  private _audit(
    toolName: string,
    args: Record<string, unknown>,
    url: string | null,
    decision: AuditDecision,
    transport: string | undefined,
    label: CallLabel | undefined,
  ): void {
    if (label === undefined) {
      audit(toolName, args, url, decision, transport);
    } else if (label.replacedBy !== undefined) {
      audit(label.replacedBy, label.args, url, decision, transport, label.tool);
    } else {
      audit(label.tool, label.args, url, decision, transport);
    }
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

  private _matchedProtected(url: string | null): string | null {
    if (!url) return null;
    for (const pattern of this._protected) {
      if (pattern.test(url)) return pattern.source;
    }
    return null;
  }

  private _withinRateLimit(): boolean {
    const limit = this.config.maxActionsPerMinute;
    if (!limit || limit <= 0) return true;

    const now = Date.now();
    const cutoff = now - 60_000;

    while (this._actionTimes.length > 0 && this._actionTimes[0]! <= cutoff) {
      this._actionTimes.shift();
    }

    if (this._actionTimes.length >= limit) {
      return false;
    }

    this._actionTimes.push(now);
    return true;
  }

  private _deny(decision: string, message: string, url?: string): SafetyDenial {
    return { success: false, safetyDecision: decision, error: message, ...(url !== undefined ? { url } : {}) };
  }

  private _compilePatterns(): void {
    const errors: string[] = [];
    const compile = (sources: string[], list: PatternListName): UrlPattern[] => {
      const { patterns, issues } = compileUrlPatterns(sources, list);
      for (const issue of issues) {
        const line = `${list}_url_patterns '${issue.pattern}': ${issue.message}`;
        if (issue.fatal) {
          errors.push(line);
        } else {
          this._patternWarnings.push(line);
          process.stderr.write(`[KitsuneMCP] safety.json ${line}\n`);
        }
      }
      return patterns;
    };
    this._blocked = compile(this.config.blockedUrlPatterns, 'blocked');
    this._allowed = compile(this.config.allowedUrlPatterns, 'allowed');
    this._protected = compile(this.config.protectedUrlPatterns, 'protected');

    // An unusable pattern must not silently narrow the policy (a dropped
    // blocked entry, an allowlist that loses its only entry): fail closed.
    if (errors.length > 0 && this._configError === null) {
      this._configError = `invalid URL patterns: ${errors.join('; ')}`;
      process.stderr.write(
        `[KitsuneMCP] WARNING: ${this._configError}. The safety guard refuses every tool.\n`,
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
