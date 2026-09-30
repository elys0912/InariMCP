/**
 * Tool registration — bridges TOOL_SCHEMAS to McpServer.registerTool().
 *
 * Uses the FOX_CAPS environment variable to control which tools are
 * registered, keeping token budgets manageable when other MCP servers
 * are co-resident.
 *
 * Fork-source: server.py register_tools() (simplified — Python version
 * registered tools inline; here we separate schema, handler, and
 * registration concerns).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_SCHEMAS } from './schemas.js';
import { toolAnnotations } from './classification.js';
import { ENV } from '@kitsune-mcp/shared';

/**
 * Callback that executes one tool call. In the stdio relay it forwards the
 * call to the shared daemon (relay/daemon-client.ts); the daemon itself runs
 * tools through handlers.ts createToolHandler().
 */
export type ToolCallHandler = (
  args: Record<string, unknown>,
  extra: { signal: AbortSignal },
) => Promise<CallToolResult>;

// ---------------------------------------------------------------------------
// Profile definitions
// ---------------------------------------------------------------------------

/**
 * Named profiles that group tool names.
 * `fox_safety_status` is always registered regardless of profile.
 */
const PROFILES: Record<string, string[]> = {
  core: [
    'fox_navigate',
    'fox_click',
    'fox_type',
    'fox_press_key',
    'fox_screenshot',
    'fox_snapshot',
    'fox_get_elements',
    'fox_get_text',
    'fox_find_text',
    'fox_get_tabs',
    'fox_create_tab',
    'fox_close_tab',
    'fox_switch_tab',
    'fox_wait_for_element',
  ],

  logs: [
    'fox_start_logging',
    'fox_stop_logging',
    'fox_get_console_logs',
    'fox_get_network_logs',
    'fox_clear_logs',
  ],

  script: [
    'fox_execute_script',
    'fox_eval_chain',
    'fox_inject_observer',
    'fox_remove_observer',
  ],

  workflow: [
    'fox_run_workflow',
    'fox_audit_page',
    'fox_wait_and_act',
  ],

  human: [
    'fox_request_approval',
    'fox_detect_captcha',
  ],

  container: [
    'fox_list_containers',
    'fox_open_in_container',
  ],

  wait: [
    'fox_wait_for_element',
    'fox_wait_for_network_idle',
    'fox_wait_for_navigation',
    'fox_wait_for_url',
  ],
};

/** Tool that is always registered regardless of profile. */
const ALWAYS_REGISTERED = 'fox_safety_status';

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the set of tool names that should be registered.
 *
 * @param capsEnv - The `FOX_CAPS` value (comma-separated profile names,
 *                  or `"all"`). When undefined/empty, ALL tools are registered
 *                  for backward compatibility.
 * @returns A Set of tool names to register.
 */
function resolveToolSet(capsEnv: string | undefined): Set<string> {
  // No FOX_CAPS → register everything (backward compat)
  if (!capsEnv || capsEnv.trim() === '') {
    return new Set(Object.keys(TOOL_SCHEMAS));
  }

  const segments = capsEnv
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  // "all" → register everything
  if (segments.includes('all')) {
    return new Set(Object.keys(TOOL_SCHEMAS));
  }

  const toolSet = new Set<string>();

  for (const segment of segments) {
    const profileTools = PROFILES[segment];
    if (profileTools) {
      for (const t of profileTools) {
        toolSet.add(t);
      }
    } else {
      // Unknown profile name — warn but don't crash
      process.stderr.write(
        `[KitsuneMCP] Unknown FOX_CAPS profile: '${segment}' (ignored)\n`,
      );
    }
  }

  // fox_safety_status is always present
  toolSet.add(ALWAYS_REGISTERED);

  return toolSet;
}

/**
 * Names of the tools exposed under the current FOX_CAPS (or the given
 * override; the daemon's HTTP entry points pass 'all').
 */
export function getRegisteredToolNames(capsOverride?: string): Set<string> {
  const toolSet = resolveToolSet(capsOverride ?? process.env[ENV.FOX_CAPS]);
  for (const name of toolSet) {
    if (!TOOL_SCHEMAS[name]) toolSet.delete(name);
  }
  return toolSet;
}

// ---------------------------------------------------------------------------
// registerTools
// ---------------------------------------------------------------------------

/**
 * Register browser tools with the MCP server.
 *
 * Reads `FOX_CAPS` from the environment (or the explicit `capsOverride`
 * parameter) to determine which profiles to load.
 *
 * @param server         - The McpServer instance.
 * @param handlerFactory - Builds the callback for one tool name.
 * @param capsOverride   - Optional override for `FOX_CAPS` (useful in tests).
 * @returns The number of tools registered.
 */
export function registerTools(
  server: McpServer,
  handlerFactory: (toolName: string) => ToolCallHandler,
  capsOverride?: string,
): number {
  const capsEnv = capsOverride ?? process.env[ENV.FOX_CAPS];
  const toolSet = resolveToolSet(capsEnv);

  let count = 0;

  for (const toolName of toolSet) {
    const def = TOOL_SCHEMAS[toolName];
    if (!def) {
      process.stderr.write(
        `[KitsuneMCP] Tool '${toolName}' in profile but not in TOOL_SCHEMAS (skipped)\n`,
      );
      continue;
    }

    // Extract the Zod object shape for McpServer.registerTool().
    // The MCP SDK expects a ZodRawShapeCompat (Record<string, ZodType>),
    // which is the `.shape` of a ZodObject.
    const zodShape = extractZodShape(def.inputSchema);

    const handler = handlerFactory(toolName);

    server.registerTool(
      toolName,
      {
        description: def.description,
        inputSchema: zodShape,
        // MCP tool annotations for client-side hints
        annotations: toolAnnotations(def),
      },
      handler,
    );

    count++;
  }

  process.stderr.write(
    `[KitsuneMCP] Registered ${count} tools` +
    (capsEnv ? ` (FOX_CAPS=${capsEnv})` : ' (all)') +
    '\n',
  );

  return count;
}

// ---------------------------------------------------------------------------
// Zod shape extraction helper
// ---------------------------------------------------------------------------

/**
 * Extract the raw shape from a Zod schema.
 *
 * McpServer.registerTool() accepts a ZodRawShapeCompat
 * (Record<string, ZodType>), which is the `.shape` property of a ZodObject.
 * Our TOOL_SCHEMAS store the full ZodObject, so we need to unwrap it.
 */
function extractZodShape(
  schema: import('zod').ZodType,
): Record<string, import('zod').ZodType> {
  // ZodObject has a .shape getter that returns the raw shape
  if ('shape' in schema && typeof schema.shape === 'object' && schema.shape !== null) {
    return schema.shape as Record<string, import('zod').ZodType>;
  }

  // Fallback: wrap in empty object (shouldn't happen with our schemas)
  return {};
}
