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
import { errorResult } from './daemon-client.js';

/** The part of DaemonClient the handler uses (replaceable in tests). */
export interface RelayClient {
  readonly baseUrl: string;
  ready(): Promise<boolean>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
  settingsMismatch(timeoutMs?: number): Promise<string[]>;
  protocolMismatch?(): string | undefined;
}

/** Runs one tool call (the relay wraps the daemon call in the approval flow). */
export type Invoke = (toolName: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<CallToolResult>;

type Content = CallToolResult['content'];

function warningBlocks(warnings: string[]): Content {
  return warnings.map((w) => ({ type: 'text' as const, text: `WARNING: ${w}` }));
}

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
  let notice: Promise<string[]> | null = null;

  const checkNotice = (): Promise<string[]> => {
    notice ??= client.ready()
      .then(async (ok) => {
        if (!ok) return [];
        const protocol = client.protocolMismatch?.();
        return protocol !== undefined ? [protocol] : client.settingsMismatch();
      })
      .then((warnings) => {
        for (const w of warnings) log(`WARNING: ${w}`);
        return warnings;
      })
      .catch(() => []);
    return notice;
  };

  return {
    startNotice(): void {
      if (!delivered) void checkNotice();
    },

    handlerFor: (toolName) => async (args, extra) => {
      if (!(await client.ready())) {
        return errorResult(`KitsuneMCP daemon unavailable at ${client.baseUrl} (see ~/.kitsune-mcp/logs/daemon.log)`);
      }
      const result = await invoke(toolName, args, extra.signal);
      if (result.isError) return result;

      if (toolName === 'fox_safety_status') {
        // Re-check on every status call: the daemon may have been restarted
        // by another session since this relay started.
        delivered = true;
        const mismatch = await client.settingsMismatch();
        if (mismatch.length === 0) return result;
        return { ...result, content: [...result.content, ...warningBlocks(mismatch)] };
      }

      if (!delivered) {
        delivered = true;
        const warnings = await checkNotice();
        if (warnings.length > 0) {
          return { ...result, content: [...result.content, ...warningBlocks(warnings)] };
        }
      }
      return result;
    },
  };
}
