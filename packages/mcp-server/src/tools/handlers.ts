/**
 * Tool handler factory and dispatch logic.
 *
 * Each MCP tool call flows through a common pipeline:
 *   0. Argument refusals    — password fields, invalid regexes (before the
 *                             guard: they neither count against the rate
 *                             limit nor leave an `allowed` audit line).
 *                             Skipped while the safety config cannot be
 *                             used: the guard then refuses as config_error.
 *   1. SafetyGuard.check()  — policy enforcement
 *   2. BrowserCommand build — action + data + tabId + requestId (the zod-
 *      validated arguments as is: schema keys are camelCase, like the Extension's)
 *   3. sendCommand()        — forward to Extension / headless backend
 *   4. Post-processing      — URL tracking, screenshot resource_link, sanitize
 *   5. Return ToolResult    — unified envelope back to Claude Code
 *
 * Human approval (Layer 4/7): every acting tool, and reads of a
 * confirm_read_sites site, are answered `confirmation_required` — by the
 * guard or by the Extension — which opens a human-approval request
 * (safety/approval.ts) and returns it in the result details
 * (`details.approval`). The caller (normally the stdio relay,
 * relay/approval.ts) obtains the human decision and retries with the
 * one-time `approvalToken` it was issued.
 *
 * Fork-source: server.py L1009-1245 execute_tool() + _dispatch_action()
 */

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  BrowserAction,
  BrowserCommand,
  BrowserResponse,
  BrowserSafetyDecision,
  ToolResult,
  WireUrlRule,
} from '@inari-mcp/shared';
import { BROWSER_ACTIONS, BROWSER_SAFETY_DECISIONS, ErrorCode, isRecord, urlPatternProblem } from '@inari-mcp/shared';
import { LAYER_OF, PAGE_READ_TOOLS, TAB_INDEPENDENT_TOOLS, getSafetyGuard, targetUrlOf } from '../safety/guard.js';
import type { CallLabel, SafetyDenial, SafetyGuard } from '../safety/guard.js';
import {
  REQUEST_TTL_MS,
  SUMMARY_MAX,
  SUMMARY_VALUE_MAX,
  approvalDisplayUrl,
  approvalTargetFor,
  getApprovalStore,
  hashArgs,
  summarizeArgs,
} from '../safety/approval.js';
import type { ApprovalGrant } from '../safety/approval.js';
import type { SafetyConfig } from '../safety/config.js';
import { getContainerConfig } from '../safety/container.js';
import { sanitizeResult, sanitizeString } from '../safety/sanitizer.js';
import { compileUrlPatterns } from '../safety/url-pattern.js';
import type { PatternListName } from '../safety/url-pattern.js';
import { applyPasswordPolicy, passwordSelectorRefusal } from '../safety/password-guard.js';
import { getConnectionManager } from '../connection/manager.js';
import { resolveOperation } from './operations.js';
import { NAVIGATE_ACTIONS, SAFETY_STATUS_TOOL, SCREENSHOT_SCOPES } from './schemas.js';
import type { NavigateAction, OperationName, ScreenshotScope } from './schemas.js';
import { isOneOf } from './one-of.js';

const MS_PER_SECOND = 1_000;

// ---------------------------------------------------------------------------
// Action-name mapping
// ---------------------------------------------------------------------------

/**
 * Maps tool names to browser action names where they differ.
 * Default rule: strip `fox_` prefix → action name (checked against
 * BROWSER_ACTIONS). This table lists exceptions only.
 */
const ACTION_MAP: Readonly<Partial<Record<OperationName, BrowserAction>>> = {
  fox_switch_tab: 'focus_tab',
  fox_detect_captcha: 'solve_captcha',
};

/**
 * fox_navigate sub-action routing.
 * The `action` argument in fox_navigate maps to different browser actions.
 */
const NAVIGATE_ACTION_MAP: Record<NavigateAction, BrowserAction> = {
  goto: 'navigate',
  back: 'go_back',
  forward: 'go_forward',
  refresh: 'refresh',
  hard_refresh: 'hard_refresh',
};

/**
 * fox_screenshot scope routing.
 * The `scope` argument determines which browser action to dispatch.
 */
const SCREENSHOT_SCOPE_MAP: Record<ScreenshotScope, BrowserAction> = {
  viewport: 'screenshot',
  full_page: 'screenshot',
  all_tabs: 'screenshot_all_tabs',
  scroll_capture: 'scroll_and_capture',
};

// ---------------------------------------------------------------------------
// Resolve browser action from tool name + args
// ---------------------------------------------------------------------------

/**
 * The browser action of an operation call. Only the operations routed by
 * an argument are listed; every other one goes by ACTION_MAP or its name.
 */
function resolveAction(
  toolName: OperationName,
  args: Record<string, unknown>,
): BrowserAction {
  switch (toolName) {
    case 'fox_navigate': {
      const navAction = args['action'];
      return isOneOf(NAVIGATE_ACTIONS, navAction) ? NAVIGATE_ACTION_MAP[navAction] : 'navigate';
    }
    case 'fox_screenshot': {
      const scope = args['scope'];
      return isOneOf(SCREENSHOT_SCOPES, scope) ? SCREENSHOT_SCOPE_MAP[scope] : 'screenshot';
    }
    default:
      break;
  }

  // Explicit map overrides
  const mapped = ACTION_MAP[toolName];
  if (mapped !== undefined) return mapped;

  // Default: strip fox_ prefix
  const stripped = toolName.replace(/^fox_/, '');
  if (!isOneOf(BROWSER_ACTIONS, stripped)) {
    throw new Error(`${toolName}: no browser action '${stripped}' (add it to ACTION_MAP)`);
  }
  return stripped;
}

// ---------------------------------------------------------------------------
// Build BrowserCommand data payload
// ---------------------------------------------------------------------------

/** The data of the command: the arguments, plus what an operation always adds. */
function buildCommandData(
  toolName: OperationName,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const data = { ...args };

  switch (toolName) {
    case 'fox_screenshot': {
      const scope = args['scope'] ?? 'viewport';
      // full_page: the fullPage flag of the screenshot action.
      if (scope === 'full_page') {
        data['fullPage'] = true;
      }
      // all_tabs: the Extension only attaches imageData when includeData is
      // true, and the Native Host needs it to save the files the result links
      // to (imagePath). The base64 never reaches the client either way: the
      // Native Host replaces it with imagePath.
      if (scope === 'all_tabs') {
        data['includeData'] = true;
      }
      break;
    }
    case 'fox_detect_captcha':
      // solve_captcha always runs in detect-only mode: the project never
      // tries to get past a CAPTCHA, and the caller cannot override this
      // (set after the arguments, so it wins over any argument of the same
      // name).
      data['detectOnly'] = true;
      break;
    default:
      break;
  }

  return data;
}

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

/**
 * Arguments the backends compile with `new RegExp()`, always without flags
 * (case-sensitive) on both backends: fox_get_tabs, fox_screenshot all_tabs,
 * fox_wait_for_url, fox_wait_for_navigation. A case-insensitive part needs
 * a character class such as `[Ee]xample`. Each must also pass the limits of
 * shared/src/url-pattern-limit.ts (length, a repeated group that holds a
 * quantifier or `|`, the number and weight of the quantifiers and `|`, m of
 * `{n,m}`), which the Extension checks again.
 */
const REGEX_ARGUMENTS = ['urlPattern'] as const;

/** Error message for the first regex argument that is refused or does not compile, or null. */
export function invalidRegexArgument(args: Record<string, unknown>): string | null {
  for (const key of REGEX_ARGUMENTS) {
    const value = args[key];
    if (typeof value !== 'string') continue;
    const problem = urlPatternProblem(value);
    if (problem !== null) return `Invalid ${key}: ${problem}`;
    try {
      new RegExp(value);
    } catch (e) {
      return `Invalid ${key} '${value}': ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Safety metadata forwarded to the Extension
// ---------------------------------------------------------------------------

/** safety.json patterns as the URL rules the Extension matches (extension/src/url-rule.ts). */
function wireRules(sources: string[], list: PatternListName): WireUrlRule[] {
  return compileUrlPatterns(sources, list).patterns.map((p) => p.wire);
}

/**
 * Attach safety metadata that only the Extension can enforce:
 *   - containerScope: Layer 0, on EVERY command (the Extension checks the
 *     target tab's cookieStoreId; the server cannot see tabs).
 *   - confirmReadUrlRules: confirm_read_sites as URL rules, on every reading
 *     tool (PAGE_READ_TOOLS: fox_screenshot of every scope, fox_get_text,
 *     ...) when the guard is enabled and the list is not empty. The guard's
 *     Layer 4 only knows the last URL it saw for the tab, so the Extension
 *     refuses with safetyDecision "confirmation_required" when the actual
 *     target tab matches; screenshot all_tabs skips such tabs.
 *   - blockedUrlRules / allowedUrlRules: when the guard is enabled and the
 *     list is not empty, on every tool the guard checks against the target
 *     tab's last-known URL (not tab-independent, no target URL: see
 *     targetUrlOf() in safety/guard.ts; the `url` of fox_wait_for_url and of
 *     fox_navigate back / forward / refresh is not one). The Extension refuses the
 *     command when the actual target tab violates the lists, and multi-tab
 *     actions skip such tabs: the guard may not know the tab's URL.
 * Acting tools need no metadata: the Extension and the headless backend
 * refuse every acting command that does not carry `approvedHost` for the
 * site it acts on (buildCommand).
 */
export function attachSafetyMetadata(
  command: BrowserCommand,
  config: SafetyConfig,
  toolName: OperationName,
  args: Record<string, unknown>,
): void {
  const containerCfg = getContainerConfig(config);
  if (containerCfg.enabled) {
    command.containerScope = { containerName: containerCfg.containerName };
  }

  if (config.enabled && config.confirmReadSites.length > 0 && PAGE_READ_TOOLS.has(toolName)) {
    command.confirmReadUrlRules = wireRules(config.confirmReadSites, 'confirmRead');
  }

  // The same rule as the guard's pre-check: a call with a target URL is
  // checked against that URL by the guard, any other call against the tab.
  const targetUrl = targetUrlOf(toolName, args);
  if (config.enabled && targetUrl === null && !TAB_INDEPENDENT_TOOLS.has(toolName)) {
    if (config.blockedUrlPatterns.length > 0) {
      command.blockedUrlRules = wireRules(config.blockedUrlPatterns, 'blocked');
    }
    if (config.allowedUrlPatterns.length > 0) {
      command.allowedUrlRules = wireRules(config.allowedUrlPatterns, 'allowed');
    }
  }
}

// ---------------------------------------------------------------------------
// ToolResult → MCP CallToolResult conversion
// ---------------------------------------------------------------------------

/** Headless fox_snapshot result: the tree is text and is shown as such, not as an escaped JSON string. */
function isAriaSnapshot(
  data: unknown,
): data is Record<string, unknown> & { format: 'aria-yaml'; snapshot: string } {
  return isRecord(data) && data['format'] === 'aria-yaml' && typeof data['snapshot'] === 'string';
}

/**
 * Keys of a failed browser result that the model needs to fix the call
 * (the option list of a select, dialogs handled meanwhile, warnings). Only
 * these are forwarded, under a fixed top-level key, so page-derived data can
 * not pose as e.g. a confirmation request (relay/approval.ts reads
 * `confirmationRequired` from top-level JSON blocks).
 */
const FAILURE_DETAIL_KEYS = ['availableOptions', 'dialogs', 'warnings'] as const;

/**
 * Starts the text of a failed browser result. The error text comes from the
 * page or the browser (an error message that quotes the page, say); with this prefix
 * it is never a JSON document, so it cannot pose as the approval request
 * relay/approval.ts looks for in the JSON blocks of a result.
 */
export const BROWSER_ERROR_PREFIX = 'Browser error: ';

export function toolResultToCallResult(result: ToolResult): CallToolResult {
  if (result.success) {
    if (isAriaSnapshot(result.data)) {
      const { snapshot, ...meta } = result.data;
      const truncated = meta['truncated'] === true
        ? `\n[truncated: ${snapshot.length} of ${String(meta['totalLength'])} chars]`
        : '';
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(meta) },
          { type: 'text' as const, text: `${snapshot}${truncated}` },
        ],
      };
    }

    const textContent = typeof result.data === 'string'
      ? result.data
      // Compact: indentation costs tokens and no reader needs it.
      : JSON.stringify(result.data ?? { success: true });

    return {
      content: [{ type: 'text' as const, text: textContent }],
    };
  }

  // Error case
  const errorText = result.error ?? 'Unknown error';
  const details = result.details ? `\n\nDetails: ${JSON.stringify(result.details)}` : '';
  const code = result.code ? ` [${result.code}]` : '';

  const content: CallToolResult['content'] = [
    { type: 'text' as const, text: `${BROWSER_ERROR_PREFIX}${errorText}${code}${details}` },
  ];
  const data = result.data;
  if (isRecord(data)) {
    const kept: Record<string, unknown> = {};
    for (const key of FAILURE_DETAIL_KEYS) {
      if (key in data) kept[key] = data[key];
    }
    if (Object.keys(kept).length > 0) {
      content.push({ type: 'text' as const, text: JSON.stringify({ browser: kept }) });
    }
  }

  return { content, isError: true };
}

/**
 * A refusal as the tool result shows it: a SafetyDenial of the guard, one
 * the browser made, or (`denied`) a browser refusal with a decision this
 * server does not know.
 */
type SafetyRefusal =
  Omit<SafetyDenial, 'success' | 'safetyDecision'> & { safetyDecision: SafetyDenial['safetyDecision'] | 'denied' };

/**
 * Convert a refusal into a CallToolResult. `extraDetails` are added to the
 * machine-readable block (details.approval).
 */
function safetyDenialToCallResult(
  denial: SafetyRefusal,
  extraDetails: Record<string, unknown> = {},
): CallToolResult {
  const details: Record<string, unknown> = {
    code: 'SAFETY_BLOCKED',
    // A config error is in no layer (null): left out as before.
    layer: denial.layer ?? undefined,
    decision: denial.safetyDecision,
    url: denial.url,
  };

  const parts = [denial.error];

  if (denial.confirmationRequired && denial.elicitation) {
    const { url, matchedPattern } = denial.elicitation;
    const page = url !== null ? `'${url}'` : 'page not known';
    const readSite = matchedPattern !== null ? ` (confirm_read_sites: '${matchedPattern}')` : '';
    parts.push(`\nConfirmation required: ${page}${readSite}.`);
    details['confirmationRequired'] = true;
    details['elicitation'] = denial.elicitation;
  }

  // URLs and browser error text in a denial come from the page; the extra
  // details are the server's own and are not sanitized (the page URL in
  // details.approval is sanitized where it is built: openApprovalRequest).
  const sanitized = sanitizeResult(details);
  return {
    content: [
      { type: 'text' as const, text: sanitizeString(parts.join('')) },
      { type: 'text' as const, text: JSON.stringify({ ...(isRecord(sanitized) ? sanitized : {}), ...extraDetails }) },
    ],
    isError: true,
  };
}

/**
 * `details.approval` of a confirmation_required result: the open approval
 * request the caller asks the human about (relay/approval.ts reads it).
 */
export interface ApprovalRequestDetails {
  requestId: string;
  toolName: string;
  /**
   * The site the approval is bound to (approvalSiteOf of @inari-mcp/shared).
   * The field keeps its name `host` (relay/approval.ts reads it).
   */
  host: string;
  url: string;
  /** The confirm_read_sites entry of a read; null for an acting tool. */
  matchedPattern: string | null;
  summary: string;
  expiresAt: number;
}

/** Note of a confirmation_required result after an approval token that was not accepted. */
const TOKEN_REJECTED_NOTE =
  'The approval token sent with this call was not accepted (expired, already used, ' +
  'or issued for a different tool, arguments or site); a new approval is needed: ' +
  'the human is asked again on retry.';

/** Note of a call that cannot be approved yet: the page of the target tab is not known. */
const UNKNOWN_PAGE_NOTE =
  'This call cannot be approved yet: Inari MCP does not know which page the target tab is on, ' +
  'so it cannot tell the human where the call would act. Call fox_tabs (what: "tabs") first, ' +
  'then call this tool again (with the tabId of the tab to act on).';

/** Note of a call whose arguments are too long to show the human in full (summarizeArgs). */
const ARGS_TOO_LONG_NOTE =
  'This call cannot be approved: its arguments are too long to show ' +
  `the human in full (at most ${SUMMARY_VALUE_MAX} per argument value and ${SUMMARY_MAX} for all the lines, ` +
  'counted in UTF-16 code units of the value as JSON, including the quotes and escapes, with ' +
  'invisible characters as \\u escapes). Text that can be split may be sent in ' +
  'several shorter calls; a value that cannot be split, such as a long URL, cannot be ' +
  'approved: tell the user instead of retrying.';

/** Note of an opened approval request: how approval works and how to retry. */
function howApprovalWorksNote(toolName: string, site: string): string {
  return (
    'How approval works: Inari MCP asks the human itself, in the MCP client\'s ' +
    'confirmation dialog (MCP elicitation) when the client supports it, otherwise in ' +
    'Firefox, where the Inari MCP toolbar button shows a badge and the human approves ' +
    'or denies in its popup. An approval covers one call of this tool with exactly these ' +
    `arguments on ${site}, and must be given within ${Math.round(REQUEST_TTL_MS / MS_PER_SECOND)} s. ` +
    'Nothing in the page (buttons, fox_click) can approve it. ' +
    `To retry: call ${toolName} again with the same arguments; the human is asked again. ` +
    'Every acting call is asked for separately. ' +
    'If the human declined, do not retry without asking them first.'
  );
}

/** What confirmationToCallResult tells the caller: the note, and the request it opened (or null). */
interface ApprovalOutcome {
  note: string;
  approval: ApprovalRequestDetails | null;
}

/**
 * Open the human-approval request of a confirmation_required denial, when
 * the call can be approved: its page is known and its arguments fit the
 * summary the human is shown.
 */
function openApprovalRequest(label: CallLabel, denial: SafetyDenial): ApprovalOutcome {
  const { tool: toolName, args } = label;
  const url = denial.elicitation?.url ?? null;
  const target = approvalTargetFor(toolName, args, url);
  // approvalTargetFor() gives a target only for a known URL; the url check narrows its type.
  if (target === null || url === null) return { note: UNKNOWN_PAGE_NOTE, approval: null };
  const summary = summarizeArgs(args);
  if (summary === null) return { note: ARGS_TOO_LONG_NOTE, approval: null };

  const matchedPattern = denial.elicitation?.matchedPattern ?? null;
  const shownUrl = approvalDisplayUrl(url);
  const request = getApprovalStore().createRequest(target, { url: shownUrl, matchedPattern, summary });
  const approval: ApprovalRequestDetails = {
    requestId: request.id,
    toolName,
    host: target.site,
    // The page's URL, bound for the MCP client: sanitized like the URLs of
    // the result. The popup shows the request's own `url`.
    url: sanitizeString(shownUrl),
    matchedPattern,
    summary: request.summary,
    expiresAt: request.expiresAt,
  };
  return { note: howApprovalWorksNote(toolName, target.site), approval };
}

/**
 * Turn a confirmation_required denial into its tool result, opening a
 * human-approval request for exactly this call. The text tells the LLM how
 * approval works and how to retry; the JSON block carries the request for
 * the relay.
 */
function confirmationToCallResult(
  label: CallLabel,
  denial: SafetyDenial,
  tokenRejected: boolean,
): CallToolResult {
  const outcome = openApprovalRequest(label, denial);
  const notes = tokenRejected ? [TOKEN_REJECTED_NOTE, outcome.note] : [outcome.note];

  const result = safetyDenialToCallResult(denial, outcome.approval !== null ? { approval: outcome.approval } : {});
  const first = result.content[0];
  if (first && first.type === 'text') first.text += `\n\n${notes.join('\n')}`;
  return result;
}

// ---------------------------------------------------------------------------
// Screenshot post-processing (resource_link, never base64)
// ---------------------------------------------------------------------------

/**
 * Collect screenshot file paths from a browser response payload.
 *
 * Both backends report files the same way:
 *   - single capture: `data.imagePath`
 *   - all_tabs:       `data.screenshots[i].imagePath`
 * (Extension path: the Native Host saved the image and replaced `imageData`
 * with `imagePath`. Headless path: the backend saved it itself.)
 */
function collectImagePaths(data: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const single = data['imagePath'];
  if (typeof single === 'string' && single) paths.push(single);

  const shots = data['screenshots'];
  if (Array.isArray(shots)) {
    for (const shot of shots) {
      if (isRecord(shot) && typeof shot['imagePath'] === 'string' && shot['imagePath']) {
        paths.push(shot['imagePath']);
      }
    }
  }
  return paths;
}

function mimeTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

/** One MCP resource_link content block per saved screenshot file. */
function screenshotResourceLinks(paths: string[]): CallToolResult['content'] {
  return paths.map((p) => ({
    type: 'resource_link' as const,
    uri: pathToFileURL(p).href,
    name: path.basename(p),
    mimeType: mimeTypeFor(p),
    description: 'Screenshot saved by Inari MCP',
  }));
}

// ---------------------------------------------------------------------------
// createToolHandler — factory for MCP tool callbacks
// ---------------------------------------------------------------------------

/**
 * Create an MCP tool callback function for the given tool name.
 *
 * The returned function matches the MCP SDK's ToolCallback signature:
 *   (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>
 *
 * @param transport Caller label for the audit log ('stdio' for MCP clients,
 *                  'http' for POST /mcp/call). Every entry point goes through
 *                  the same SafetyGuard pipeline.
 */
export interface ToolCallOptions {
  /**
   * One-time human-approval token for this exact call (safety/approval.ts),
   * sent out of band (POST /mcp/call body) after the human approved.
   * Consumed on use.
   */
  approvalToken?: string;
}

export function createToolHandler(
  calledName: string,
  transport: string = 'stdio',
): (args: Record<string, unknown>, options?: ToolCallOptions) => Promise<CallToolResult> {
  return toolCall(calledName, transport);
}

/** One operation call on its way through the pipeline. */
interface CallContext {
  guard: SafetyGuard;
  toolName: OperationName;
  args: Record<string, unknown>;
  transport: string;
  label: CallLabel;
}

function toolCall(
  calledName: string,
  transport: string,
): (args: Record<string, unknown>, options?: ToolCallOptions) => Promise<CallToolResult> {
  return async (
    calledArgs: Record<string, unknown>,
    options: ToolCallOptions = {},
  ): Promise<CallToolResult> => {
    const guard = getSafetyGuard();

    // The operation the call runs (tools/operations.ts): from here on the
    // guard, the password guard and the command are those of the operation;
    // messages, approvals and the audit log use the name the caller used.
    const { op: toolName, args, label } = resolveOperation(calledName, calledArgs);
    const call: CallContext = { guard, toolName, args, transport, label };

    // -----------------------------------------------------------------------
    // fox_safety_status: server-internal, no browser command needed
    // -----------------------------------------------------------------------
    if (toolName === SAFETY_STATUS_TOOL) {
      const status = guard.status();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(status) }],
      };
    }

    // A presented approval token is consumed here, before anything else:
    // single use even when the call is then refused for another reason.
    const token = options.approvalToken;
    const presented = typeof token === 'string' && token !== '';
    const grant: ApprovalGrant | null = presented
      ? getApprovalStore().consume(token, label.tool, hashArgs(label.args))
      : null;

    // -----------------------------------------------------------------------
    // 1. Refusals of the arguments themselves. Not while the policy cannot
    //    be used: the guard then refuses the call as config_error first.
    // -----------------------------------------------------------------------
    if (guard.configError === null) {
      const refusal = refuseArguments(call);
      if (refusal !== null) return refusal;
    }

    // -----------------------------------------------------------------------
    // 2. Safety check
    // -----------------------------------------------------------------------
    // A confirmation_required answer after a presented token means the token
    // did not lift it (not valid, or approved for another host): say so.
    const denial = guard.check(toolName, args, transport, grant, label);
    if (denial !== null) {
      return denial.safetyDecision === 'confirmation_required'
        ? confirmationToCallResult(label, denial, presented)
        : safetyDenialToCallResult(denial);
    }

    // -----------------------------------------------------------------------
    // 3. Resolve action and build command
    // -----------------------------------------------------------------------
    const command = buildCommand(call, grant);

    // -----------------------------------------------------------------------
    // 4. Send command to browser
    // -----------------------------------------------------------------------
    const response = await getConnectionManager().sendCommand(command);
    if (!response.success && response.safetyDecision) {
      return browserRefusalToResult(call, response.safetyDecision, response, presented);
    }

    // -----------------------------------------------------------------------
    // 5-6. Post-processing and the result
    // -----------------------------------------------------------------------
    return finishResult(call, response);
  };
}

/**
 * Refusals of the arguments themselves, before the guard: a call refused
 * here is not counted against the rate limit and leaves no `allowed` line
 * in the audit log. Null when the arguments are acceptable.
 */
function refuseArguments({ guard, toolName, args, transport, label }: CallContext): CallToolResult | null {
  // Password-field protection (fox_type / fox_set_value): a safety
  // refusal, audited as `denied`.
  const passwordRefusal = passwordSelectorRefusal(
    toolName, args, guard.config.allowPasswordTyping,
  );
  if (passwordRefusal !== null) {
    guard.recordAudit(toolName, args, 'denied', transport, label);
    return { content: [{ type: 'text' as const, text: passwordRefusal }], isError: true };
  }

  // Regex arguments are compiled by the backends; refuse invalid ones here
  // (an input error like a schema violation: not audited).
  const regexError = invalidRegexArgument(args);
  if (regexError !== null) {
    return {
      content: [{ type: 'text' as const, text: `${regexError} [${ErrorCode.INVALID_ARGUMENTS}]` }],
      isError: true,
    };
  }
  return null;
}

/** The BrowserCommand of an allowed call, with the safety metadata attached. */
function buildCommand({ guard, toolName, args }: CallContext, grant: ApprovalGrant | null): BrowserCommand {
  const action = resolveAction(toolName, args);
  const data = buildCommandData(toolName, args);
  // Set after the arguments, so it wins over any argument of the same name.
  applyPasswordPolicy(toolName, data, guard.config.allowPasswordTyping);

  // Extract tabId before sending (it goes at BrowserCommand level)
  const tabId = typeof data['tabId'] === 'number' ? data['tabId'] : undefined;
  delete data['tabId'];

  const command: BrowserCommand = {
    action,
    tabId,
    data,
    requestId: '', // Will be assigned by connectionManager.sendCommand()
  };
  attachSafetyMetadata(command, guard.config, toolName, args);
  // The human approved this call for one site: the Extension and the
  // headless backend run an acting command (or a read of a
  // confirm_read_sites site) only on that site. approvedHost names the site,
  // not who approved: with FOX_APPROVAL_ELICITATION on (the default) the
  // answer reaches the daemon over local HTTP, where a local process holding
  // the API token can answer as well (README, Human approval).
  if (grant !== null) {
    // The wire field keeps its name `approvedHost`; its value is a site (approvalSiteOf).
    command.approvedHost = grant.target.site;
  }
  return command;
}

/**
 * The browser safety refusals other than confirmation_required: whether the
 * refused URL the browser reports is where the target tab really is
 * (Layer 3 lists), so that the guard's own pre-check refuses the next call.
 * The audit decision is the browser's decision; the layer is LAYER_OF's.
 */
const BROWSER_REFUSAL_NOTES_URL: Readonly<Record<Exclude<BrowserSafetyDecision, 'confirmation_required'>, boolean>> = {
  out_of_scope: false,
  blocked_url: true,
  not_allowlisted: true,
  config_error: false,
  paused: false,
};

/**
 * The tool result text of a refusal while the user has paused the agent. It
 * replaces the Extension's own text (dispatch.ts PAUSED_REFUSAL), which only
 * says that the user paused: this one also tells the model that every call
 * is refused until the switch is off, so that it stops retrying.
 */
const PAUSED_MESSAGE =
  'paused: The user paused the agent in the toolbar popup. Every call is refused until the user turns the pause switch off.';

/** The URL a browser result reports (`data.url`), or null. */
function reportedUrlOf(response: BrowserResponse): string | null {
  const url = response.data?.['url'];
  return typeof url === 'string' && url ? url : null;
}

/** The confirm_read_sites entry a browser refusal reports (`data.matchedPattern`), or null. */
function reportedPatternOf(response: BrowserResponse): string | null {
  const pattern = response.data?.['matchedPattern'];
  return typeof pattern === 'string' && pattern ? pattern : null;
}

/** The browser's own text of a refusal, else one that names the decision. */
function browserRefusalText(response: BrowserResponse, decision: string): string {
  return response.error ?? `Refused by browser safety check (${decision})`;
}

/** A browser refusal with a safetyDecision this server does not know: refused as `denied`. */
function unknownRefusalToResult(
  { guard, toolName, args, transport, label }: CallContext,
  decision: string,
  response: BrowserResponse,
  refusedUrl: string | null,
): CallToolResult {
  process.stderr.write(
    `[InariMCP] The browser refused ${label.tool} with an unknown safetyDecision ` +
    `${JSON.stringify(decision)}; treated as denied.\n`,
  );
  guard.recordAudit(toolName, args, 'denied', transport, label, refusedUrl ?? undefined);
  return safetyDenialToCallResult({ safetyDecision: 'denied', layer: null, error: browserRefusalText(response, decision) });
}

/**
 * The result of a refusal the browser made itself (`safetyDecision`):
 * confirmation_required (the actual target tab is on a site the call was not
 * approved for, or a read's tab matches confirm_read_sites: the same
 * elicitation result as guard Layer 4/7), Layer 0 out_of_scope, Layer 3
 * blocked_url / not_allowlisted on the actual target tab, config_error
 * (the browser could not use the attached rules), or paused (the user's
 * pause switch in the toolbar popup): SAFETY_BLOCKED, distinct
 * from ordinary browser errors. A decision this server does not know is
 * refused as `denied` and reported on stderr.
 */
function browserRefusalToResult(
  call: CallContext,
  decision: string,
  response: BrowserResponse,
  presented: boolean,
): CallToolResult {
  const { guard, toolName, args, transport, label } = call;
  const refusedUrl = reportedUrlOf(response);
  if (!isOneOf(BROWSER_SAFETY_DECISIONS, decision)) return unknownRefusalToResult(call, decision, response, refusedUrl);

  if (decision === 'confirmation_required') {
    const confirmation = guard.confirmationFromBrowser(toolName, args, {
      url: refusedUrl,
      matchedPattern: reportedPatternOf(response),
      transport,
      label,
    });
    return confirmationToCallResult(label, confirmation, presented);
  }

  const notesUrl = BROWSER_REFUSAL_NOTES_URL[decision] && refusedUrl !== null;
  // Remember where the tab really is, so the next call is refused
  // by the guard's own pre-check.
  if (notesUrl) guard.noteRefusedUrl(refusedUrl, args);
  // The command was sent (the guard's `allowed` line stands); this line
  // records what the browser decided.
  guard.recordAudit(toolName, args, decision, transport, label, refusedUrl ?? undefined);
  const error = decision === 'paused' ? PAUSED_MESSAGE : browserRefusalText(response, decision);
  return safetyDenialToCallResult({
    safetyDecision: decision,
    layer: LAYER_OF[decision],
    error,
    ...(notesUrl ? { url: refusedUrl } : {}),
  });
}

/**
 * Post-processing of a browser answer that is no safety refusal, and the
 * tool result: URL tracking and the check of the URL the command ended on,
 * screenshot resource_links, sanitizing, the audit line of a failure.
 */
function finishResult(
  { guard, toolName, args, transport, label }: CallContext,
  response: BrowserResponse,
): CallToolResult {
  // Track the page URL after every successful operation (data.url, or
  // data.tab.url) per tab, so the guard's checks see the current page on
  // both the Extension and headless paths. Then check the URL the command
  // ended on: a redirect or a clicked link may have reached a blocked site.
  // (Without data too: fox_close_tab answers {success: true} alone.)
  if (response.success) {
    const resultData = response.data ?? {};
    guard.noteUrl(resultData, args, toolName);
    const reached = guard.checkReachedUrl(toolName, args, resultData, transport, label);
    if (reached !== null) return safetyDenialToCallResult(reached);
  }

  // Saved screenshot files → resource_link blocks (both backends).
  const imagePaths = response.success && response.data
    ? collectImagePaths(response.data)
    : [];

  // Sanitize sensitive data from response
  const sanitizedData = sanitizeResult(response.data);

  // Audit log: the guard already recorded the call as allowed; only a
  // failure adds a line, and it is no safety decision.
  if (!response.success) guard.recordAudit(toolName, args, 'browser_error', transport, label);

  const toolResult: ToolResult = response.success
    ? { success: true, data: sanitizedData }
    : {
      success: false,
      // Error text can carry page-derived content (messages that quote the page, URLs).
      error: sanitizeString(response.error ?? 'Browser command failed'),
      data: sanitizedData,
    };

  const callResult = toolResultToCallResult(toolResult);
  if (imagePaths.length > 0) {
    callResult.content.push(...screenshotResourceLinks(imagePaths));
  }
  return callResult;
}
