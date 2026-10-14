/**
 * InariMCP stdio relay — what `claude mcp add ... node dist/index.js`
 * starts, once per Claude Code session.
 *
 * Speaks MCP JSON-RPC on stdio and binds no port. tools/list is answered
 * locally from PUBLIC_TOOLS (filtered by this session's FOX_CAPS); each
 * tools/call is forwarded to the shared daemon's POST /mcp/call, which runs
 * zod validation and the SafetyGuard, and its CallToolResult is returned
 * unchanged — except confirmation-required results: for those the relay
 * asks the human (MCP elicitation, else the Extension's popup) and repeats
 * the call once with the one-time approval token (relay/approval.ts).
 *
 * stdout carries JSON-RPC only; every log line goes to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ENV, shortId } from '@inari-mcp/shared';
import { registerTools } from '../tools/registry.js';
import { DaemonClient } from './daemon-client.js';
import { callWithApproval, canElicit } from './approval.js';
import { isElicitationApprovalEnabled } from '../safety/approval.js';
import type { ApprovalDeps } from './approval.js';
import { createRelayHandlers } from './handler.js';
import { PACKAGE_VERSION } from '../version.js';
import { stderrLogger } from '@inari-mcp/shared/node';

const SERVER_NAME = 'inari-mcp';
/** Cap of each precheck request (GET /health, then GET /daemon/info). */
const PRECHECK_TIMEOUT_MS = 400;
/**
 * Longest wait, before the MCP connect, for an already-running daemon's
 * settings: the two precheck requests run one after the other.
 */
const PRECHECK_BUDGET_MS = 2 * PRECHECK_TIMEOUT_MS;

const log = stderrLogger('relay');

/** The part of DaemonClient the precheck uses (replaceable in tests). */
export type PrecheckClient = Pick<DaemonClient, 'checkHealth' | 'protocolMismatch' | 'checkSettings'>;

/**
 * Check an already-running daemon before the MCP connect: its protocol, then
 * its settings. Each request is capped at `timeoutMs`, so the losing side of
 * the race with `budgetMs` ends by itself; its result is only dropped.
 *
 * @returns warnings for the server instructions (empty: checked, none); null
 *          when no daemon answered or the budget ran out
 */
export async function precheckDaemon(
  client: PrecheckClient,
  budgetMs: number = PRECHECK_BUDGET_MS,
  timeoutMs: number = PRECHECK_TIMEOUT_MS,
): Promise<string[] | null> {
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async (): Promise<string[] | null> => {
        if (!(await client.checkHealth(timeoutMs))) return null;
        const protocol = client.protocolMismatch();
        return protocol !== undefined ? [protocol] : client.checkSettings(timeoutMs);
      })(),
      new Promise<null>((resolve) => { budgetTimer = setTimeout(() => resolve(null), budgetMs); }),
    ]);
  } finally {
    clearTimeout(budgetTimer);
  }
}

/** Server instructions carrying the precheck warnings, if there are any. */
export function instructionsFor(known: string[] | null): { instructions?: string } {
  return known !== null && known.length > 0 ? { instructions: known.join('\n') } : {};
}

export async function runRelay(): Promise<void> {
  const relayId = shortId();
  const client = new DaemonClient(relayId);

  // Answer initialize at once: starting a daemon can take many seconds. Only a
  // daemon that is already running is checked first (briefly), so a settings
  // mismatch can still go into the server instructions. Otherwise the first
  // tool call waits for the daemon (client.ready()) and carries the warning.
  const known = await precheckDaemon(client);
  for (const w of known ?? []) log(`WARNING: ${w}`);

  const mcpServer = new McpServer(
    { name: SERVER_NAME, version: PACKAGE_VERSION },
    { capabilities: { tools: {} }, ...instructionsFor(known) },
  );

  const approvalDeps = (signal: AbortSignal): ApprovalDeps => ({
    // FOX_APPROVAL_ELICITATION off: always the Extension's popup.
    canElicit: isElicitationApprovalEnabled() && canElicit(mcpServer.server.getClientCapabilities()),
    elicit: (params, timeoutMs) => mcpServer.server.elicitInput(params, { timeout: timeoutMs, signal }),
    reportElicitation: (requestId, approved) => client.reportElicitation(requestId, approved),
    askBrowser: (requestId) => client.askBrowser(requestId, signal),
    log,
  });

  const handlers = createRelayHandlers(
    client,
    known,
    log,
    (toolName, args, signal) => callWithApproval(
      (approvalToken) => client.callTool(toolName, args, signal, approvalToken),
      approvalDeps(signal ?? new AbortController().signal),
    ),
  );
  const toolCount = registerTools(mcpServer, handlers.handlerFor);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  client.startHeartbeat();
  handlers.startNotice();

  log(
    `relay ${relayId} ready: ${toolCount} tools (FOX_CAPS=${process.env[ENV.FOX_CAPS] || 'all'}), ` +
    `daemon ${client.baseUrl}`,
  );

  // The client closed stdin (session ended): nothing more to relay.
  const exit = (): void => {
    client.stopHeartbeat();
    process.exit(0);
  };
  process.stdin.on('end', exit);
  process.on('SIGINT', exit);
  process.on('SIGTERM', exit);
}
