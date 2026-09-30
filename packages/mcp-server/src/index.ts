/**
 * KitsuneMCP — MCP server entry point.
 *
 * Two roles, one executable:
 *
 *   node dist/index.js            stdio relay (default). What Claude Code
 *                                 starts, one per session. Binds no port;
 *                                 forwards tool calls to the daemon and
 *                                 starts the daemon when none is running.
 *                                 See relay/main.ts.
 *   node dist/index.js --daemon   shared daemon. The single owner of the
 *                                 HTTP / WebSocket ports, SafetyGuard,
 *                                 connection manager and headless backend.
 *                                 Started on demand by a relay or by the
 *                                 Native Host. See daemon/main.ts.
 *
 * Fork-source: stdio_wrapper.py (relay) + server.py (daemon).
 *
 * stderr is the only output channel for log messages — in relay mode stdout
 * is reserved for the MCP JSON-RPC stream.
 */

import { installProcessHandlers } from './utils/process-handlers.js';

const isDaemon = process.argv.slice(2).includes('--daemon');
const role = isDaemon ? 'daemon' : 'relay';

// Global error handlers (policy: utils/process-handlers.ts)
installProcessHandlers(role);

// ---------------------------------------------------------------------------
// Launch — each role loads only its own modules (the relay never loads
// Playwright, the SafetyGuard or the transports).
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (isDaemon) {
    const { runDaemon } = await import('./daemon/main.js');
    await runDaemon();
  } else {
    const { runRelay } = await import('./relay/main.js');
    await runRelay();
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[KitsuneMCP:${role}] Failed to start: ${msg}\n`);
  process.exit(1);
});
