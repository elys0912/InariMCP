/**
 * Tool handler factory and dispatch logic.
 *
 * Each MCP tool call flows through a common pipeline:
 *   1. SafetyGuard.check()  — policy enforcement
 *   2. Argument camelize    — snake_case → camelCase for Extension
 *   3. BrowserCommand build — action + data + tabId + requestId
 *   4. sendCommand()        — forward to Extension / headless backend
 *   5. Post-processing      — URL tracking, screenshot resource_link, sanitize
 *   6. Return ToolResult    — unified envelope back to Claude Code
 *
 * Fork-source: server.py L1009-1245 execute_tool() + _dispatch_action()
 */

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BrowserAction, BrowserCommand, ToolResult } from '@kitsune-mcp/shared';
import { getSafetyGuard } from '../safety/guard.js';
import type { SafetyConfig } from '../safety/config.js';
import { getContainerConfig } from '../safety/container.js';
import { sanitizeResult } from '../safety/sanitizer.js';
import { audit } from '../safety/audit.js';
import type { AuditDecision } from '../safety/audit.js';
import { camelizeArgs } from '../utils/camelize.js';
import { getConnectionManager } from '../connection/manager.js';

// ---------------------------------------------------------------------------
// Action-name mapping
// ---------------------------------------------------------------------------

/**
 * Maps tool names to browser action names where they differ.
 * Default rule: strip `fox_` prefix → action name.
 * This table lists exceptions only.
 */
const ACTION_MAP: Record<string, BrowserAction> = {
  fox_switch_tab: 'focus_tab',
  fox_detect_captcha: 'solve_captcha',
  fox_inject_observer: 'inject_observer',
  fox_remove_observer: 'remove_observer',
  fox_snapshot: 'snapshot',
  fox_find_text: 'find_text',
  fox_handle_dialog: 'handle_dialog',
  fox_list_containers: 'list_containers',
  fox_open_in_container: 'open_in_container',
  fox_wait_for_navigation: 'wait_for_navigation',
  fox_wait_for_url: 'wait_for_url',
};

/**
 * fox_navigate sub-action routing.
 * The `action` argument in fox_navigate maps to different browser actions.
 */
const NAVIGATE_ACTION_MAP: Record<string, BrowserAction> = {
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
const SCREENSHOT_SCOPE_MAP: Record<string, BrowserAction> = {
  viewport: 'screenshot',
  full_page: 'screenshot',
  all_tabs: 'screenshot_all_tabs',
  scroll_capture: 'scroll_and_capture',
};

// ---------------------------------------------------------------------------
// Resolve browser action from tool name + args
// ---------------------------------------------------------------------------

function resolveAction(
  toolName: string,
  args: Record<string, unknown>,
): BrowserAction {
  // fox_navigate: sub-action routing
  if (toolName === 'fox_navigate') {
    const navAction = (args['action'] as string) ?? 'goto';
    return NAVIGATE_ACTION_MAP[navAction] ?? 'navigate';
  }

  // fox_screenshot: scope routing
  if (toolName === 'fox_screenshot') {
    const scope = (args['scope'] as string) ?? 'viewport';
    return SCREENSHOT_SCOPE_MAP[scope] ?? 'screenshot';
  }

  // Explicit map overrides
  if (ACTION_MAP[toolName]) {
    return ACTION_MAP[toolName];
  }

  // Default: strip fox_ prefix
  return toolName.replace(/^fox_/, '') as BrowserAction;
}

// ---------------------------------------------------------------------------
// Build BrowserCommand data payload
// ---------------------------------------------------------------------------

function buildCommandData(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const data = camelizeArgs(args);

  // fox_screenshot: add fullPage flag for full_page scope
  if (toolName === 'fox_screenshot') {
    const scope = args['scope'] ?? 'viewport';
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
  }

  // fox_detect_captcha → solve_captcha always runs in detect-only mode: the
  // project never tries to get past a CAPTCHA (design.md 4.1), and the
  // caller cannot override this (set after camelize, so it wins over any
  // argument of the same name).
  if (toolName === 'fox_detect_captcha') {
    data['detectOnly'] = true;
  }

  // fox_navigate goto: url must be in data
  // (already there from args, just verify)

  return data;
}

// ---------------------------------------------------------------------------
// Safety metadata forwarded to the Extension
// ---------------------------------------------------------------------------

/**
 * Attach safety metadata that only the Extension can enforce:
 *   - containerScope: Layer 0, on EVERY command (the Extension checks the
 *     target tab's cookieStoreId; the server cannot see tabs).
 *   - protectedUrlPatterns: on screenshot, scroll_and_capture and
 *     screenshot_all_tabs, only when the guard is enabled and
 *     confirmProtectedActions is true.
 *     all_tabs: the Extension excludes protected tabs from the capture.
 *     screenshot / scroll_and_capture: the Extension refuses with
 *     safetyDecision "confirmation_required" when the actual target tab is
 *     protected — the server-side Layer 4 check only knows the last URL it
 *     saw.
 */
const PROTECTED_CAPTURE_ACTIONS: ReadonlySet<BrowserAction> = new Set<BrowserAction>([
  'screenshot',
  'scroll_and_capture',
  'screenshot_all_tabs',
]);

function attachSafetyMetadata(command: BrowserCommand, config: SafetyConfig): void {
  const containerCfg = getContainerConfig(config);
  if (containerCfg.enabled) {
    command.containerScope = { containerName: containerCfg.containerName };
  }

  if (
    PROTECTED_CAPTURE_ACTIONS.has(command.action) &&
    config.enabled &&
    config.confirmProtectedActions &&
    config.protectedUrlPatterns.length > 0
  ) {
    command.protectedUrlPatterns = [...config.protectedUrlPatterns];
  }
}

// ---------------------------------------------------------------------------
// ToolResult → MCP CallToolResult conversion
// ---------------------------------------------------------------------------

function toolResultToCallResult(result: ToolResult): CallToolResult {
  if (result.success) {
    const textContent = typeof result.data === 'string'
      ? result.data
      : JSON.stringify(result.data ?? { success: true }, null, 2);

    return {
      content: [{ type: 'text' as const, text: textContent }],
    };
  }

  // Error case
  const errorText = result.error ?? 'Unknown error';
  const details = result.details ? `\n\nDetails: ${JSON.stringify(result.details)}` : '';
  const code = result.code ? ` [${result.code}]` : '';

  return {
    content: [{ type: 'text' as const, text: `${errorText}${code}${details}` }],
    isError: true,
  };
}

/**
 * Convert a SafetyDenial into a CallToolResult.
 */
function safetyDenialToCallResult(
  denial: {
    error: string;
    layer?: number;
    decision?: string;
    url?: string;
    confirmationRequired?: true;
    elicitation?: {
      protectedUrl: string;
      matchedPattern: string;
      toolName: string;
    };
  },
): CallToolResult {
  const details: Record<string, unknown> = {
    code: 'SAFETY_BLOCKED',
    layer: denial.layer,
    decision: denial.decision,
    url: denial.url,
  };

  const parts = [denial.error];

  if (denial.confirmationRequired && denial.elicitation) {
    parts.push(
      `\nConfirmation required: protected URL '${denial.elicitation.protectedUrl}' ` +
      `(pattern: '${denial.elicitation.matchedPattern}').`,
    );
    details.confirmationRequired = true;
    details.elicitation = denial.elicitation;
  }

  return {
    content: [
      { type: 'text' as const, text: parts.join('') },
      { type: 'text' as const, text: JSON.stringify(details) },
    ],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Screenshot post-processing (design.md 5.5: resource_link, never base64)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

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
    description: 'Screenshot saved by KitsuneMCP',
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
export function createToolHandler(
  toolName: string,
  transport: string = 'stdio',
): (args: Record<string, unknown>) => Promise<CallToolResult> {
  return async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const guard = getSafetyGuard();

    // -----------------------------------------------------------------------
    // fox_safety_status: server-internal, no browser command needed
    // -----------------------------------------------------------------------
    if (toolName === 'fox_safety_status') {
      const status = guard.status();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }],
      };
    }

    // -----------------------------------------------------------------------
    // 1. Safety check
    // -----------------------------------------------------------------------
    const denial = guard.check(toolName, args, transport);
    if (denial !== null) {
      return safetyDenialToCallResult({ ...denial, decision: denial.safetyDecision });
    }

    // -----------------------------------------------------------------------
    // 2. fox_type password protection
    // -----------------------------------------------------------------------
    if (toolName === 'fox_type' && !guard.config.allowPasswordTyping) {
      const selector = (args['selector'] as string) ?? '';
      if (/type\s*=\s*["']?password/i.test(selector)) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Typing into password fields is blocked by safety policy ' +
                  '(allowPasswordTyping is false in safety config).',
          }],
          isError: true,
        };
      }
    }

    // -----------------------------------------------------------------------
    // 3. Resolve action and build command
    // -----------------------------------------------------------------------
    const action = resolveAction(toolName, args);
    const data = buildCommandData(toolName, args);

    // Extract tabId before sending (it goes at BrowserCommand level)
    const tabId = typeof data['tabId'] === 'number' ? data['tabId'] as number : undefined;
    delete data['tabId'];

    const command: BrowserCommand = {
      action,
      tabId,
      data,
      requestId: '', // Will be assigned by connectionManager.sendCommand()
    };
    attachSafetyMetadata(command, guard.config);

    // -----------------------------------------------------------------------
    // 4. Send command to browser
    // -----------------------------------------------------------------------
    const connectionManager = getConnectionManager();
    const response = await connectionManager.sendCommand(command);

    // Extension-side refusal: the target tab matched protectedUrlPatterns
    // (single-tab screenshot). Same elicitation result as guard Layer 7.
    if (!response.success && response.safetyDecision === 'confirmation_required') {
      const reportedUrl = response.data?.['url'];
      const confirmation = guard.confirmationFromBrowser(
        toolName,
        args,
        typeof reportedUrl === 'string' && reportedUrl ? reportedUrl : null,
        transport,
      );
      return safetyDenialToCallResult({ ...confirmation, decision: confirmation.safetyDecision });
    }

    // Other Extension-side safety refusals (e.g. Layer 0 out_of_scope):
    // surface as SAFETY_BLOCKED, distinct from ordinary browser errors.
    if (!response.success && response.safetyDecision) {
      const decision = response.safetyDecision;
      const auditDecision: AuditDecision = decision === 'out_of_scope' ? 'out_of_scope' : 'denied';
      if (guard.config.auditLog) {
        audit(toolName, args, (args['url'] as string) ?? null, auditDecision, transport);
      }
      return safetyDenialToCallResult({
        error: response.error ?? `Refused by browser safety check (${decision})`,
        decision,
        layer: decision === 'out_of_scope' ? 0 : undefined,
      });
    }

    // -----------------------------------------------------------------------
    // 5. Post-processing
    // -----------------------------------------------------------------------

    // Track the page URL after every successful operation (data.url, or
    // data.tab.url), so Layer 4/7 protected-domain checks see the current
    // page on both the Extension and headless paths.
    if (response.success && response.data) {
      guard.noteUrl(response.data);
    }

    // Saved screenshot files → resource_link blocks (both backends).
    const imagePaths = response.success && response.data
      ? collectImagePaths(response.data)
      : [];

    // Sanitize sensitive data from response
    const sanitizedData = sanitizeResult(response.data);

    // Audit log
    audit(
      toolName,
      args,
      (args['url'] as string) ?? null,
      response.success ? 'allowed' : 'denied',
      transport,
    );

    // -----------------------------------------------------------------------
    // 6. Build ToolResult and convert to CallToolResult
    // -----------------------------------------------------------------------
    const toolResult: ToolResult = response.success
      ? { success: true, data: sanitizedData }
      : { success: false, error: response.error ?? 'Browser command failed', data: sanitizedData };

    const callResult = toolResultToCallResult(toolResult);
    if (imagePaths.length > 0) {
      callResult.content.push(...screenshotResourceLinks(imagePaths));
    }
    return callResult;
  };
}
