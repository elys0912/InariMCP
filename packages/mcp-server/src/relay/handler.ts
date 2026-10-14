/**
 * The relay's tools/call handler.
 *
 * The MCP connection is opened before a daemon is known to be up (starting one
 * can take many seconds), so the first tool call waits for it here
 * (client.ready()), and a settings mismatch found later reaches the model as a
 * WARNING appended to the first successful result instead of as server
 * instructions.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { daemonLogPath, errorResult } from './daemon-client.js';
// fox_safety_status: registered whatever FOX_CAPS says; its answer is where
// this handler adds the settings comparison.
import { ALWAYS_REGISTERED } from '../tools/registry.js';

/** The part of DaemonClient the handler uses (replaceable in tests). */
export interface RelayClient {
  readonly baseUrl: string;
  ready(): Promise<boolean>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
  /** Settings warnings; null when the daemon's settings could not be read. */
  checkSettings(timeoutMs?: number): Promise<string[] | null>;
  protocolMismatch?(): string | undefined;
}

/** Runs one tool call (the relay wraps the daemon call in the approval flow). */
export type Invoke = (toolName: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<CallToolResult>;

type Content = CallToolResult['content'];

function warningBlocks(warnings: string[]): Content {
  return warnings.map((w) => ({ type: 'text' as const, text: `WARNING: ${w}` }));
}

/** fox_safety_status when /daemon/info could not be read: "unknown" is not "the same". */
export const SETTINGS_UNKNOWN_NOTE =
  "NOTE: the shared daemon's settings could not be read, so whether they match this session's is unknown.";

export interface RelayHandlers {
  /** Handler factory for registerTools(). */
  handlerFor(toolName: string): (args: Record<string, unknown>, extra: { signal?: AbortSignal }) => Promise<CallToolResult>;
  /** Start the background mismatch check (call right after the MCP connect). */
  startNotice(): void;
}

/**
 * @param knownWarnings  warnings found before the connect (already delivered as
 *                       instructions; an empty array means "checked, none");
 *                       null when the daemon could not be checked in time.
 * @param log            receives each warning once
 */
export function createRelayHandlers(
  client: RelayClient,
  knownWarnings: string[] | null,
  log: (msg: string) => void,
  invoke: Invoke = (toolName, args, signal) => client.callTool(toolName, args, signal),
): RelayHandlers {
  let delivered = knownWarnings !== null;
  /** The background check; null = not started, or the last one could not read the settings. */
  let notice: Promise<string[] | null> | null = null;

  /** Resolves null when the daemon (or its settings) could not be checked: a later call tries again. */
  const checkNotice = (): Promise<string[] | null> => {
    notice ??= client.ready()
      .then(async (ok) => {
        if (!ok) return null; // no daemon yet
        const protocol = client.protocolMismatch?.();
        const warnings = protocol !== undefined ? [protocol] : await client.checkSettings();
        for (const w of warnings ?? []) log(`WARNING: ${w}`);
        return warnings;
      })
      .catch(() => null)
      .then((warnings) => {
        if (warnings === null) notice = null;
        return warnings;
      });
    return notice;
  };

  return {
    startNotice(): void {
      if (!delivered) void checkNotice();
    },

    handlerFor: (toolName) => async (args, extra) => {
      if (!(await client.ready())) {
        return errorResult(`InariMCP daemon unavailable at ${client.baseUrl} (see ${daemonLogPath()})`);
      }
      const result = await invoke(toolName, args, extra.signal);
      if (result.isError) return result;

      if (toolName === ALWAYS_REGISTERED) {
        // Re-check on every status call: the daemon may have been restarted
        // by another session since this relay started.
        const mismatch = await client.checkSettings();
        if (mismatch === null) {
          return { ...result, content: [...result.content, { type: 'text' as const, text: SETTINGS_UNKNOWN_NOTE }] };
        }
        delivered = true;
        if (mismatch.length === 0) return result;
        return { ...result, content: [...result.content, ...warningBlocks(mismatch)] };
      }

      if (!delivered) {
        const warnings = await checkNotice();
        // Another call may have delivered them while this one waited.
        if (warnings !== null && !delivered) {
          delivered = true;
          if (warnings.length > 0) {
            return { ...result, content: [...result.content, ...warningBlocks(warnings)] };
          }
        }
      }
      return result;
    },
  };
}
