#!/usr/bin/env node
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
 * `--help` / `--version` print and exit before anything else happens (no
 * daemon, token or log file); an unknown argument exits with code 2
 * (cli.ts).
 *
 * Fork-source: stdio_wrapper.py (relay) + server.py (daemon).
 *
 * stderr is the only output channel for log messages — in relay mode stdout
 * is reserved for the MCP JSON-RPC stream.
 */

import { helpText, parseArgs } from './cli.js';
import { PACKAGE_VERSION } from './version.js';
import { installProcessHandlers } from './utils/process-handlers.js';

const command = parseArgs(process.argv.slice(2));

async function main(): Promise<void> {
  switch (command.kind) {
    case 'help':
      process.stdout.write(helpText());
      return;
    case 'version':
      process.stdout.write(`${PACKAGE_VERSION}\n`);
      return;
    case 'error':
      process.stderr.write(`kitsune-mcp: ${command.message}\n\n${helpText()}`);
      process.exitCode = 2;
      return;
    case 'daemon': {
      // Global error handlers (policy: utils/process-handlers.ts)
      installProcessHandlers('daemon');
      // Each role loads only its own modules (the relay never loads
      // Playwright, the SafetyGuard or the transports).
      const { runDaemon } = await import('./daemon/main.js');
      await runDaemon();
      return;
    }
    case 'relay': {
      installProcessHandlers('relay');
      const { runRelay } = await import('./relay/main.js');
      await runRelay();
      return;
    }
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[KitsuneMCP:${command.kind}] Failed to start: ${msg}\n`);
  process.exit(1);
});
