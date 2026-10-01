/**
 * Tool registration — bridges the public tools (public-tools.ts), or with
 * FOX_CAPS=legacy the pre-consolidation tools (schemas.ts), to
 * McpServer.registerTool().
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
import { PUBLIC_TOOLS } from './public-tools.js';
import { deprecationNote } from './operations.js';
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
 * Named profiles that group tool names, as they were before the WP13
 * consolidation (FOX_CAPS=legacy,<profile>).
 * `fox_safety_status` is always registered regardless of profile.
 */
const LEGACY_PROFILES: Record<string, string[]> = {
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

/**
 * Named profiles that group the public tools (tools/public-tools.ts).
 * Every public tool is in at least one. `fox_safety_status` is always
 * registered regardless of profile.
 */
const PROFILES: Record<string, string[]> = {
  core: [
    'fox_navigate',
    'fox_click',
    'fox_type',
    'fox_press_key',
    'fox_set_value',
    'fox_screenshot',
    'fox_snapshot',
    'fox_read',
    'fox_find',
    'fox_tabs',
    'fox_tab',
    'fox_interact',
    'fox_wait',
    'fox_handle_dialog',
  ],
  logs: ['fox_logging', 'fox_get_logs'],
  script: ['fox_evaluate', 'fox_observer'],
  // The old workflow profile: fox_wait_and_act is fox_evaluate mode=wait_and_act.
  workflow: ['fox_evaluate'],
  human: ['fox_request_approval', 'fox_detect_captcha'],
  // Containers are fox_tabs what=containers and fox_tab action=create with container.
  container: ['fox_tabs', 'fox_tab'],
  wait: ['fox_wait'],
};

/** Tool that is always registered regardless of profile. */
const ALWAYS_REGISTERED = 'fox_safety_status';

/**
 * FOX_CAPS segment that selects the pre-consolidation tool names (the
 * operations of schemas.ts) instead of the public tools. Alone it means
 * all of them; the other segments then name LEGACY_PROFILES.
 */
const LEGACY_SEGMENT = 'legacy';

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

interface ToolSet {
  /** Pre-consolidation names (FOX_CAPS contains `legacy`). */
  legacy: boolean;
  names: Set<string>;
}

/**
 * Resolve the set of tool names that should be registered.
 *
 * @param capsEnv - The `FOX_CAPS` value (comma-separated profile names,
 *                  or `"all"`, optionally with `legacy`). When
 *                  undefined/empty, all public tools are registered.
 */
function resolveToolSet(capsEnv: string | undefined): ToolSet {
  const all = (capsEnv ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const legacy = all.includes(LEGACY_SEGMENT);
  const segments = all.filter((s) => s !== LEGACY_SEGMENT);
  const catalog = legacy ? TOOL_SCHEMAS : PUBLIC_TOOLS;
  const profiles = legacy ? LEGACY_PROFILES : PROFILES;

  // No profile or "all" → register everything
  if (segments.length === 0 || segments.includes('all')) {
    return { legacy, names: new Set(Object.keys(catalog)) };
  }

  const names = new Set<string>();

  for (const segment of segments) {
    const profileTools = profiles[segment];
    if (profileTools) {
      for (const t of profileTools) {
        names.add(t);
      }
    } else {
      // Unknown profile name — warn but don't crash
      process.stderr.write(
        `[KitsuneMCP] Unknown FOX_CAPS profile: '${segment}' (ignored)\n`,
      );
    }
  }

  // fox_safety_status is always present
  names.add(ALWAYS_REGISTERED);

  return { legacy, names };
}

// ---------------------------------------------------------------------------
// registerTools
// ---------------------------------------------------------------------------

interface Registration {
  description: string;
  inputSchema: Record<string, import('zod').ZodType>;
  annotations: Record<string, boolean>;
}

/** What tools/list shows for a public tool. */
function publicRegistration(name: string): Registration | null {
  const tool = PUBLIC_TOOLS[name];
  if (!tool) return null;
  return {
    description: tool.description,
    inputSchema: extractZodShape(tool.listSchema),
    // fox_safety_status reads the server's own policy, nothing outside it.
    annotations: name === ALWAYS_REGISTERED
      ? { ...tool.annotations, openWorldHint: false }
      : { ...tool.annotations },
  };
}

/** What tools/list shows for a pre-consolidation name (FOX_CAPS=legacy). */
function legacyRegistration(name: string): Registration | null {
  const def = TOOL_SCHEMAS[name];
  if (!def) return null;
  const note = deprecationNote(name);
  return {
    description: note === null ? def.description : `[Deprecated: ${note}] ${def.description}`,
    inputSchema: extractZodShape(def.inputSchema),
    annotations: { ...toolAnnotations(def) },
  };
}

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
  const { legacy, names } = resolveToolSet(capsEnv);

  let count = 0;

  for (const toolName of names) {
    const registration = legacy ? legacyRegistration(toolName) : publicRegistration(toolName);
    if (!registration) {
      process.stderr.write(
        `[KitsuneMCP] Tool '${toolName}' in profile but not defined (skipped)\n`,
      );
      continue;
    }

    server.registerTool(toolName, registration, handlerFactory(toolName));

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
