/**
 * KitsuneMCP stdio relay — what `claude mcp add ... node dist/index.js`
 * starts, once per Claude Code session.
 *
 * Speaks MCP JSON-RPC on stdio and binds no port. tools/list is answered
 * locally from TOOL_SCHEMAS (filtered by this session's FOX_CAPS); each
 * tools/call is forwarded to the shared daemon's POST /mcp/call, which runs
 * zod validation and the SafetyGuard, and its CallToolResult is returned
 * unchanged — except confirmation-required results: for those the relay
 * asks the human (MCP elicitation, else the Extension's popup) and repeats
 * the call once with the one-time approval token (relay/approval.ts).
 *
 * stdout carries JSON-RPC only; every log line goes to stderr.
 */

import * as crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ENV } from '@kitsune-mcp/shared';
import { registerTools } from '../tools/registry.js';
import { DaemonClient } from './daemon-client.js';
import { callWithApproval, canElicit } from './approval.js';
import { isElicitationApprovalEnabled } from '../safety/approval.js';
import type { ApprovalDeps } from './approval.js';
import { createRelayHandlers } from './handler.js';
import { PACKAGE_VERSION } from '../version.js';

const SERVER_NAME = 'kitsune-mcp';
/** Longest wait, before the MCP connect, for an already-running daemon's settings. */
const PRECHECK_BUDGET_MS = 800;
const PRECHECK_TIMEOUT_MS = 400;

function log(msg: string): void {
  process.stderr.write(`[KitsuneMCP:relay] ${msg}\n`);
}

export async function runRelay(): Promise<void> {
  const relayId = crypto.randomBytes(4).toString('hex');
  const client = new DaemonClient(relayId);

  // Answer initialize at once: starting a daemon can take many seconds. Only a
  // daemon that is already running is checked first (briefly), so a settings
  // mismatch can still go into the server instructions. Otherwise the first
  // tool call waits for the daemon (client.ready()) and carries the warning.
  const known = await Promise.race([
    (async (): Promise<string[] | null> => {
      if (!(await client.checkHealth(PRECHECK_TIMEOUT_MS))) return null;
      const protocol = client.protocolMismatch();
      return protocol !== undefined ? [protocol] : client.checkSettings(PRECHECK_TIMEOUT_MS);
    })(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), PRECHECK_BUDGET_MS)),
  ]);
  for (const w of known ?? []) log(`WARNING: ${w}`);

  const mcpServer = new McpServer(
    { name: SERVER_NAME, version: PACKAGE_VERSION },
    {
      capabilities: { tools: {} },
      ...(known !== null && known.length > 0 ? { instructions: known.join('\n') } : {}),
    },
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
