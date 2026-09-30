import { loadConfig, getAuditLogPath } from './config.js';
import type { SafetyConfig } from './config.js';
import { audit } from './audit.js';
import type { AuditDecision } from './audit.js';
import { checkHeadlessContainerScope } from './container.js';
import { grantCoversDenial } from './approval.js';
import type { ApprovalGrant } from './approval.js';

const SAFE_URL_RE = /^(https?:\/\/|about:blank$)/i;

export const OBSERVE_TOOLS: ReadonlySet<string> = new Set([
  'fox_screenshot', 'fox_screenshot_all_tabs',
  'fox_get_page_info', 'fox_get_elements', 'fox_get_value',
  'fox_get_text', 'fox_find_text', 'fox_get_tabs', 'fox_get_tab_info',
  'fox_find_tabs', 'fox_wait_for_element', 'fox_wait_for_change',
  'fox_wait_for_navigation', 'fox_wait_for_url',
  'fox_wait_for_network_idle', 'fox_observe_element',
  'fox_stop_observing', 'fox_scroll_and_capture',
  'fox_start_logging', 'fox_stop_logging',
  'fox_get_console_logs', 'fox_get_network_logs',
  'fox_clear_logs', 'fox_highlight', 'fox_scroll',
  'fox_hover', 'fox_focus_tab', 'fox_safety_status',
  'fox_request_approval', 'fox_audit_page', 'fox_solve_captcha',
  'fox_list_containers',
]);

export const SCRIPT_TOOLS: ReadonlySet<string> = new Set([
  'fox_execute_script', 'fox_eval_chain', 'fox_wait_and_act',
  'fox_inject_observer',
]);

export interface SafetyDenial {
  success: false;
  safetyDecision: string;
  error: string;
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
  readOnly: boolean;
  allowScriptExecution: boolean;
  confirmProtectedActions: boolean;
  allowPasswordTyping: boolean;
  maxActionsPerMinute: number;
  actionsInLastMinute: number;
  currentUrl: string | null;
  blockedUrlPatterns: string[];
  allowedUrlPatterns: string[];
  protectedUrlPatterns: string[];
  configFile: string;
  auditLog: string | null;
}

export class SafetyGuard {
  readonly config: SafetyConfig;
  private _actionTimes: number[] = [];
  private _currentUrl: string | null = null;
  private _blocked: RegExp[] = [];
  private _allowed: RegExp[] = [];
  private _protected: RegExp[] = [];

  constructor(config?: SafetyConfig) {
    this.config = config ?? loadConfig();
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
  ): SafetyDenial | null {
    if (!this.config.enabled) {
      return null;
    }

    const targetUrl = this._targetUrl(args);
    let denial = this._checkInner(toolName, targetUrl, args);
    if (grantCoversDenial(denial, grant)) denial = null;

    const isObserve = OBSERVE_TOOLS.has(toolName);
    let decision: AuditDecision;
    if (denial === null && grant) {
      decision = 'allowed_by_human';
    } else if (denial === null) {
      if (isObserve && this._isOnProtectedDomain(targetUrl)) {
        decision = 'observed_on_protected_domain';
      } else {
        decision = 'allowed';
      }
    } else if (denial.safetyDecision === 'confirmation_required') {
      decision = 'confirmation_required';
    } else {
      decision = denial.safetyDecision as AuditDecision;
    }

    if (this.config.auditLog) {
      audit(toolName, args, targetUrl ?? this._currentUrl, decision, transport);
    }

    return denial;
  }

  noteUrl(result: Record<string, unknown>): void {
    const url =
      (result['url'] as string | undefined) ??
      ((result['tab'] as Record<string, unknown> | undefined)?.['url'] as string | undefined);
    if (typeof url === 'string' && url) {
      this._currentUrl = url;
    }
  }

  /**
   * Build the Layer 7-shaped confirmation result for a refusal the Extension
   * made itself: a single-tab screenshot whose target tab URL matched the
   * `protectedUrlPatterns` attached to the command (safetyDecision
   * "confirmation_required"). The server could not have caught this when
   * its last-known URL was stale or unknown.
   *
   * @param url  The protected tab's URL if the Extension reported it
   *             (`data.url`); also recorded via noteUrl semantics.
   * @param matchedPattern  The pattern the Extension matched
   *             (`data.matchedPattern`), if reported.
   */
  confirmationFromBrowser(
    toolName: string,
    args: Record<string, unknown>,
    url: string | null,
    transport?: string,
    matchedPattern?: string | null,
  ): SafetyDenial {
    if (url) this._currentUrl = url;
    const protectedUrl = url ?? this._currentUrl ?? '(target tab)';
    const matched =
      matchedPattern ||
      this._matchedProtected(url ?? this._currentUrl) ||
      '(protected_url_patterns)';

    if (this.config.auditLog) {
      audit(toolName, args, url ?? this._currentUrl, 'confirmation_required', transport);
    }

    return {
      success: false,
      safetyDecision: 'confirmation_required',
      confirmationRequired: true,
      elicitation: { protectedUrl, matchedPattern: matched, toolName },
      error:
        `${toolName} targets a protected site ('${protectedUrl}' matches ` +
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
      readOnly: this.config.readOnly,
      allowScriptExecution: this.config.allowScriptExecution,
      confirmProtectedActions: this.config.confirmProtectedActions,
      allowPasswordTyping: this.config.allowPasswordTyping,
      maxActionsPerMinute: this.config.maxActionsPerMinute,
      actionsInLastMinute: this._actionTimes.length,
      currentUrl: this._currentUrl,
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
    args: Record<string, unknown>,
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

    // Layer 1: Rate limit
    if (!this._withinRateLimit()) {
      return this._deny(
        'rate_limited',
        `Rate limit exceeded: more than ${this.config.maxActionsPerMinute} actions ` +
        'in the last minute. Wait a few seconds and retry.',
      );
    }

    // Layer 2-3: URL scheme guard + blocklist/allowlist
    if (targetUrl !== null) {
      if (!SAFE_URL_RE.test(targetUrl)) {
        return this._deny(
          'blocked_scheme',
          `Navigation to '${targetUrl}' refused: only http://, https:// and about:blank targets are allowed.`,
        );
      }
      if (this._blocked.some((p) => p.test(targetUrl))) {
        return this._deny(
          'blocked_url',
          `URL '${targetUrl}' matches blocked_url_patterns in safety.json.`,
        );
      }
      if (this._allowed.length > 0 && !this._allowed.some((p) => p.test(targetUrl))) {
        return this._deny(
          'not_allowlisted',
          `URL '${targetUrl}' does not match allowed_url_patterns in safety.json (allowlist mode is active).`,
        );
      }
    }

    // Layer 4: Observe tools pass through.
    // Exception: a single-tab fox_screenshot on a protected domain captures
    // sensitive page content, so it gets the same elicitation as Layer 7.
    // (scope all_tabs is handled Extension-side: protected tabs are excluded.)
    if (isObserve) {
      if (toolName === 'fox_screenshot' && args['scope'] !== 'all_tabs') {
        return this._protectedConfirmation(toolName, targetUrl);
      }
      return null;
    }

    // Layer 5: Read-only mode
    if (this.config.readOnly) {
      return this._deny(
        'read_only',
        `${toolName} refused: safety guard is in read-only mode ` +
        '(readOnly in safety.json or FOX_READ_ONLY=1). ' +
        'Observation tools like fox_screenshot remain available.',
      );
    }

    // Layer 6: Script toggle
    if (isScript && !this.config.allowScriptExecution) {
      return this._deny(
        'scripts_disabled',
        `${toolName} refused: script execution is disabled ` +
        '(allowScriptExecution in safety.json or FOX_ALLOW_SCRIPTS=0).',
      );
    }

    // Layer 7: Protected domain confirmation (MCP elicitation)
    return this._protectedConfirmation(toolName, targetUrl);
  }

  /**
   * Layer 7: require human confirmation (MCP elicitation) when the target
   * URL — or, failing that, the last URL seen via noteUrl() — matches
   * protected_url_patterns. No-op when confirmProtectedActions is false.
   */
  private _protectedConfirmation(
    toolName: string,
    targetUrl: string | null,
  ): SafetyDenial | null {
    if (!this.config.confirmProtectedActions) {
      return null;
    }
    const checkUrl = targetUrl ?? this._currentUrl;
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
        toolName,
      },
      error:
        `${toolName} targets a protected site ('${checkUrl}' matches ` +
        `pattern '${matched}' in safety.json). This is a guard against ` +
        'unintended actions on sensitive sites (banking, payments, health, government). ' +
        'Human confirmation is required via MCP elicitation.',
    };
  }

  private _targetUrl(args: Record<string, unknown>): string | null {
    const url = args['url'];
    return typeof url === 'string' && url ? url : null;
  }

  private _matchedProtected(url: string | null): string | null {
    if (!url) return null;
    for (const pattern of this._protected) {
      if (pattern.test(url)) return pattern.source;
    }
    return null;
  }

  private _isOnProtectedDomain(targetUrl: string | null): boolean {
    const checkUrl = targetUrl ?? this._currentUrl;
    return this._matchedProtected(checkUrl) !== null;
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

  private _deny(decision: string, message: string): SafetyDenial {
    return { success: false, safetyDecision: decision, error: message };
  }

  private _compilePatterns(): void {
    this._blocked = this._compileList(this.config.blockedUrlPatterns);
    this._allowed = this._compileList(this.config.allowedUrlPatterns);
    this._protected = this._compileList(this.config.protectedUrlPatterns);
  }

  private _compileList(patterns: string[]): RegExp[] {
    const compiled: RegExp[] = [];
    for (const pattern of patterns) {
      try {
        compiled.push(new RegExp(pattern, 'i'));
      } catch (e) {
        process.stderr.write(
          `[KitsuneMCP] Invalid regex in safety.json: '${pattern}' ` +
          `(${e instanceof Error ? e.message : String(e)})\n`,
        );
      }
    }
    return compiled;
  }
}

let _guard: SafetyGuard | null = null;

export function getSafetyGuard(): SafetyGuard {
  if (_guard === null) {
    _guard = new SafetyGuard();
  }
  return _guard;
}
