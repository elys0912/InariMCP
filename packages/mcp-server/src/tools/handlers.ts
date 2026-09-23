/**
 * Tool handler factory and dispatch logic.
 *
 * Each MCP tool call flows through a common pipeline:
 *   1. SafetyGuard.check()  — policy enforcement
 *   2. Argument camelize    — snake_case → camelCase for Extension
 *   3. BrowserCommand build — action + data + tabId + requestId
 *   4. sendCommand()        — forward to Extension / headless backend
 *   5. Post-processing      — screenshot save, URL tracking, sanitize
 *   6. Return ToolResult    — unified envelope back to Claude Code
 *
 * Fork-source: server.py L1009-1245 execute_tool() + _dispatch_action()
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BrowserAction, BrowserCommand, ToolResult } from '@kitsune-mcp/shared';
import { getSafetyGuard } from '../safety/guard.js';
import { sanitizeResult } from '../safety/sanitizer.js';
import { audit } from '../safety/audit.js';
import { camelizeArgs } from '../utils/camelize.js';
import { saveScreenshot } from '../utils/screenshot.js';
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
  }

  // fox_navigate goto: url must be in data
  // (already there from args, just verify)

  return data;
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
// Screenshot post-processing
// ---------------------------------------------------------------------------

function handleScreenshotResult(
  args: Record<string, unknown>,
  responseData: Record<string, unknown>,
): void {
  const saveToFile = args['saveToFile'] ?? args['save_to_file'] ?? true;
  if (!saveToFile) return;

  const imageData = responseData['imageData'] as string | undefined
    ?? responseData['image_data'] as string | undefined;

  if (imageData) {
    const filename = (args['filename'] as string | undefined) ?? undefined;
    const savedPath = saveScreenshot(imageData, filename);
    responseData['savedTo'] = savedPath;
  }
}

// ---------------------------------------------------------------------------
// createToolHandler — factory for MCP tool callbacks
// ---------------------------------------------------------------------------

/**
 * Create an MCP tool callback function for the given tool name.
 *
 * The returned function matches the MCP SDK's ToolCallback signature:
 *   (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>
 */
export function createToolHandler(
  toolName: string,
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
    const denial = guard.check(toolName, args);
    if (denial !== null) {
      return safetyDenialToCallResult(denial);
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

    // -----------------------------------------------------------------------
    // 4. Send command to browser
    // -----------------------------------------------------------------------
    const connectionManager = getConnectionManager();
    const response = await connectionManager.sendCommand(command);

    // -----------------------------------------------------------------------
    // 5. Post-processing
    // -----------------------------------------------------------------------

    // fox_navigate: track URL on success
    if (toolName === 'fox_navigate' && response.success && response.data) {
      guard.noteUrl(response.data as Record<string, unknown>);
    }

    // fox_screenshot: save screenshot file
    if (toolName === 'fox_screenshot' && response.success && response.data) {
      handleScreenshotResult(args, response.data as Record<string, unknown>);
    }

    // Sanitize sensitive data from response
    const sanitizedData = sanitizeResult(response.data);

    // Audit log
    audit(
      toolName,
      args,
      (args['url'] as string) ?? null,
      response.success ? 'allowed' : 'denied',
    );

    // -----------------------------------------------------------------------
    // 6. Build ToolResult and convert to CallToolResult
    // -----------------------------------------------------------------------
    const toolResult: ToolResult = response.success
      ? { success: true, data: sanitizedData }
      : { success: false, error: response.error ?? 'Browser command failed', data: sanitizedData };

    return toolResultToCallResult(toolResult);
  };
}
