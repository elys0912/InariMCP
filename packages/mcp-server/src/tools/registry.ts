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
import type { ZodRawShape } from 'zod';
import { OPERATION_NAMES, SAFETY_STATUS_TOOL, TOOL_SCHEMAS } from './schemas.js';
import type { OperationName } from './schemas.js';
import { toolAnnotations } from './classification.js';
import { PUBLIC_TOOLS, PUBLIC_TOOL_NAMES } from './public-tools.js';
import type { PublicToolName } from './public-tools.js';
import { deprecationNote } from './operations.js';
import { isOneOf } from './one-of.js';
import { ENV } from '@inari-mcp/shared';

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

/** The FOX_CAPS profile names (the same with and without `legacy`). */
export const PROFILE_NAMES = ['core', 'logs', 'script', 'workflow', 'human', 'container', 'wait'] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

/**
 * Named profiles that group tool names, as they were before the WP13
 * consolidation (FOX_CAPS=legacy,<profile>).
 * `fox_safety_status` is always registered regardless of profile.
 * fox_wait_for_element is in core and in wait, as before WP13.
 */
const LEGACY_PROFILES: Readonly<Record<ProfileName, readonly OperationName[]>> = {
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
const PROFILES: Readonly<Record<ProfileName, readonly PublicToolName[]>> = {
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

/** Tool that is always registered regardless of profile (fox_safety_status). */
export const ALWAYS_REGISTERED = SAFETY_STATUS_TOOL;

/**
 * FOX_CAPS segment that selects the pre-consolidation tool names (the
 * operations of schemas.ts) instead of the public tools. Alone it means
 * all of them; the other segments then name LEGACY_PROFILES.
 */
const LEGACY_SEGMENT = 'legacy';

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

/** Pre-consolidation names (FOX_CAPS contains `legacy`), or the public tools. */
type ToolSet =
  | { legacy: true; names: Set<OperationName> }
  | { legacy: false; names: Set<PublicToolName> };

/**
 * The tools of the profiles named by `segments` (every tool for none or
 * `all`), plus fox_safety_status. An unknown profile name is warned about
 * and ignored.
 */
function namesOf<T extends string>(
  segments: string[],
  all: readonly T[],
  profiles: Readonly<Record<ProfileName, readonly T[]>>,
  alwaysRegistered: T,
): Set<T> {
  if (segments.length === 0 || segments.includes('all')) return new Set(all);
  const names = new Set<T>();
  for (const segment of segments) {
    if (isOneOf(PROFILE_NAMES, segment)) {
      for (const t of profiles[segment]) names.add(t);
    } else {
      // Unknown profile name: warn but don't crash
      process.stderr.write(
        `[InariMCP] Unknown FOX_CAPS profile: '${segment}' (ignored)\n`,
      );
    }
  }
  names.add(alwaysRegistered);
  return names;
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
  const segments = all.filter((s) => s !== LEGACY_SEGMENT);
  if (all.includes(LEGACY_SEGMENT)) {
    return { legacy: true, names: namesOf(segments, OPERATION_NAMES, LEGACY_PROFILES, ALWAYS_REGISTERED) };
  }
  return { legacy: false, names: namesOf(segments, PUBLIC_TOOL_NAMES, PROFILES, ALWAYS_REGISTERED) };
}

// ---------------------------------------------------------------------------
// registerTools
// ---------------------------------------------------------------------------

interface Registration {
  description: string;
  inputSchema: ZodRawShape;
  annotations: Record<string, boolean>;
}

/** What tools/list shows for a public tool. */
function publicRegistration(name: PublicToolName): Registration {
  const tool = PUBLIC_TOOLS[name];
  return {
    description: tool.description,
    inputSchema: tool.listSchema.shape,
    // fox_safety_status reads the server's own policy, nothing outside it.
    annotations: name === ALWAYS_REGISTERED
      ? { ...tool.annotations, openWorldHint: false }
      : { ...tool.annotations },
  };
}

/** What tools/list shows for a pre-consolidation name (FOX_CAPS=legacy). */
function legacyRegistration(name: OperationName): Registration {
  const def = TOOL_SCHEMAS[name];
  const note = deprecationNote(name);
  return {
    description: note === null ? def.description : `[Deprecated: ${note}] ${def.description}`,
    inputSchema: def.inputSchema.shape,
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
  const toolSet = resolveToolSet(capsEnv);
  const registrations: Array<[string, Registration]> = toolSet.legacy
    ? [...toolSet.names].map((name) => [name, legacyRegistration(name)])
    : [...toolSet.names].map((name) => [name, publicRegistration(name)]);

  let count = 0;
  for (const [toolName, registration] of registrations) {
    server.registerTool(toolName, registration, handlerFactory(toolName));
    count++;
  }

  process.stderr.write(
    `[InariMCP] Registered ${count} tools` +
    (capsEnv ? ` (FOX_CAPS=${capsEnv})` : ' (all)') +
    '\n',
  );

  return count;
}
