/**
 * Tool registration — bridges the public tools (public-tools.ts) to
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
import { SAFETY_STATUS_TOOL } from './schemas.js';
import { PUBLIC_TOOLS, PUBLIC_TOOL_NAMES } from './public-tools.js';
import type { PublicToolName } from './public-tools.js';
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

/** The FOX_CAPS profile names. */
export const PROFILE_NAMES = ['core', 'human', 'container', 'wait'] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

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
  human: ['fox_request_approval', 'fox_detect_captcha'],
  // Containers are fox_tabs what=containers and fox_tab action=create with container.
  container: ['fox_tabs', 'fox_tab'],
  wait: ['fox_wait'],
};

/** Tool that is always registered regardless of profile (fox_safety_status). */
export const ALWAYS_REGISTERED = SAFETY_STATUS_TOOL;

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the set of tool names that should be registered: the tools of the
 * profiles named in `capsEnv` (comma-separated, or `all`), plus
 * fox_safety_status. Every public tool when `capsEnv` is undefined, empty or
 * names `all`. An unknown profile name is warned about and ignored.
 */
function resolveToolNames(capsEnv: string | undefined): Set<PublicToolName> {
  const segments = (capsEnv ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (segments.length === 0 || segments.includes('all')) return new Set(PUBLIC_TOOL_NAMES);
  const names = new Set<PublicToolName>();
  for (const segment of segments) {
    if (isOneOf(PROFILE_NAMES, segment)) {
      for (const t of PROFILES[segment]) names.add(t);
    } else {
      // Unknown profile name: warn but don't crash
      process.stderr.write(
        `[InariMCP] Unknown FOX_CAPS profile: '${segment}' (ignored)\n`,
      );
    }
  }
  names.add(ALWAYS_REGISTERED);
  return names;
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
  let count = 0;
  for (const toolName of resolveToolNames(capsEnv)) {
    server.registerTool(toolName, publicRegistration(toolName), handlerFactory(toolName));
    count++;
  }

  process.stderr.write(
    `[InariMCP] Registered ${count} tools` +
    (capsEnv ? ` (FOX_CAPS=${capsEnv})` : ' (all)') +
    '\n',
  );

  return count;
}
