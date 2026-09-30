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
import type { ApprovalDeps } from './approval.js';

const PACKAGE_VERSION = '0.1.0';
const SERVER_NAME = 'kitsune-mcp';

function log(msg: string): void {
  process.stderr.write(`[KitsuneMCP:relay] ${msg}\n`);
}

export async function runRelay(): Promise<void> {
  const relayId = crypto.randomBytes(4).toString('hex');
  const client = new DaemonClient(relayId);

  // Start (or find) the daemon before answering initialize, so settings
  // mismatches can be reported in the server instructions. On failure the
  // relay still comes up; each tool call retries ensureDaemon().
  const up = await client.ensureDaemon();
  if (!up) {
    log(`shared daemon unavailable at ${client.baseUrl} — tool calls will retry`);
  }
  const warnings = up ? await client.settingsMismatch() : [];
  for (const w of warnings) log(`WARNING: ${w}`);

  const mcpServer = new McpServer(
    { name: SERVER_NAME, version: PACKAGE_VERSION },
    {
      capabilities: { tools: {} },
      ...(warnings.length > 0 ? { instructions: warnings.join('\n') } : {}),
    },
  );

  const approvalDeps = (signal: AbortSignal): ApprovalDeps => ({
    canElicit: canElicit(mcpServer.server.getClientCapabilities()),
    elicit: (params, timeoutMs) => mcpServer.server.elicitInput(params, { timeout: timeoutMs, signal }),
    reportElicitation: (requestId, approved) => client.reportElicitation(requestId, approved),
    askBrowser: (requestId) => client.askBrowser(requestId, signal),
    log,
  });

  const toolCount = registerTools(
    mcpServer,
    (toolName) => async (args, extra) => {
      const result = await callWithApproval(
        (approvalToken) => client.callTool(toolName, args, extra.signal, approvalToken),
        approvalDeps(extra.signal),
      );
      if (toolName !== 'fox_safety_status' || result.isError) return result;
      // Re-check on every status call: the daemon may have been restarted
      // by another session since this relay started.
      const mismatch = await client.settingsMismatch();
      if (mismatch.length === 0) return result;
      return {
        ...result,
        content: [
          ...result.content,
          ...mismatch.map((w) => ({ type: 'text' as const, text: `WARNING: ${w}` })),
        ],
      };
    },
  );

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  client.startHeartbeat();

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
