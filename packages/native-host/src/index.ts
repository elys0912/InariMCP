/**
 * KitsuneMCP Native Messaging Host — main entry point.
 *
 * Bridges the Firefox Extension (stdin/stdout, Native Messaging protocol)
 * and the MCP Server (HTTP on localhost).
 */

import * as http from 'node:http';
import * as path from 'node:path';
import * as os from 'node:os';
import { readMessage, sendMessage } from './protocol.js';
import { ServerLauncher } from './server-launcher.js';
import { CommandPoller } from './command-poller.js';
import { HealthMonitor } from './health-monitor.js';

function log(msg: string): void {
  process.stderr.write(`[KitsuneMCP:NativeHost] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpPost(
  host: string,
  port: number,
  urlPath: string,
  body: Record<string, unknown>,
  apiToken?: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify(body), 'utf-8');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(encoded.length),
    };
    if (apiToken) {
      headers['X-API-Key'] = apiToken;
    }

    const req = http.request(
      {
        hostname: host,
        port,
        path: urlPath,
        method: 'POST',
        headers,
        timeout: 30_000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as Record<string, unknown>);
          } catch {
            resolve({ success: false, error: 'invalid JSON response' });
          }
        });
      },
    );

    req.on('error', (err: Error) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('request timeout'));
    });

    req.write(encoded);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Message processing
// ---------------------------------------------------------------------------

function forwardToMcpServer(
  message: Record<string, unknown>,
  launcher: ServerLauncher,
): void {
  httpPost(
    launcher.host,
    launcher.httpPort,
    '/browser/command',
    message,
    launcher.getApiToken(),
  )
    .then((result) => {
      if (message['requestId']) {
        (result as Record<string, unknown>)['requestId'] = message['requestId'];
      }
      sendMessage(result);
    })
    .catch((err: unknown) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`failed to forward to MCP server: ${errorMsg}`);
      sendMessage({
        success: false,
        error: `MCP server connection failed: ${errorMsg}`,
        ...(message['requestId'] ? { requestId: message['requestId'] } : {}),
      });
    });
}

function forwardResponseToServer(
  response: Record<string, unknown>,
  launcher: ServerLauncher,
): void {
  httpPost(
    launcher.host,
    launcher.httpPort,
    '/browser/response',
    response,
    launcher.getApiToken(),
  ).catch((err: unknown) => {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`failed to forward response to server: ${errorMsg}`);
  });
}

function processMessage(
  message: Record<string, unknown>,
  launcher: ServerLauncher,
): void {
  const action = message['action'] as string | undefined;

  // Response from Extension (has requestId but no action) — forward to server
  if (message['requestId'] && !action) {
    log(`forwarding response for requestId: ${message['requestId'] as string}`);

    // Save screenshot data locally if present
    if (message['success'] && message['data']) {
      const screenshotMsg: Record<string, unknown> = {
        action: 'fox_screenshot',
        data: message['data'],
        filename: `screenshot_${Date.now()}.png`,
      };
      forwardToMcpServer(screenshotMsg, launcher);
    }

    forwardResponseToServer(message, launcher);
    return;
  }

  // Local commands
  if (action === 'ping') {
    sendMessage({
      action: 'pong',
      pong: true,
      success: true,
      timestamp: Date.now() / 1000,
      ...(message['requestId'] ? { requestId: message['requestId'] } : {}),
    });
    return;
  }

  if (action === 'status') {
    launcher.checkHealth()
      .then((available) => {
        sendMessage({
          success: true,
          mcp_server: {
            url: `http://${launcher.host}:${launcher.httpPort}`,
            available,
          },
          native_host: {
            version: '0.1.0',
            pid: process.pid,
          },
          ...(message['requestId'] ? { requestId: message['requestId'] } : {}),
        });
      })
      .catch(() => {
        sendMessage({
          success: true,
          mcp_server: {
            url: `http://${launcher.host}:${launcher.httpPort}`,
            available: false,
          },
          native_host: {
            version: '0.1.0',
            pid: process.pid,
          },
          ...(message['requestId'] ? { requestId: message['requestId'] } : {}),
        });
      });
    return;
  }

  if (action === 'saveScreenshot') {
    // Convert to fox_screenshot and forward to server
    const screenshotMsg: Record<string, unknown> = {
      action: 'fox_screenshot',
      data: message['data'],
      filename: message['filename'] ??
        `screenshot_${Date.now()}.png`,
    };
    forwardToMcpServer(screenshotMsg, launcher);
    return;
  }

  // Everything else goes to the MCP server
  forwardToMcpServer(message, launcher);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let running = true;

function shutdown(
  poller: CommandPoller,
  monitor: HealthMonitor,
  launcher: ServerLauncher,
): void {
  if (!running) return;
  running = false;
  log('shutting down');
  poller.stop();
  monitor.stop();
  // Don't stop the MCP server — it may serve other consumers
}

async function main(): Promise<void> {
  log('========================================');
  log('KitsuneMCP Native Host starting');

  const launcher = new ServerLauncher();
  log(`MCP server target: http://${launcher.host}:${launcher.httpPort}`);

  // Ensure MCP server is running
  await launcher.ensureRunning();

  const poller = new CommandPoller(
    launcher.host,
    launcher.httpPort,
    launcher.getApiToken(),
  );
  poller.start();

  const monitor = new HealthMonitor(launcher);
  monitor.start();

  // Graceful shutdown
  const onSignal = (): void => {
    shutdown(poller, monitor, launcher);
    process.exit(0);
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  log('ready — listening for Extension messages on stdin');
  log('========================================');

  // stdin read loop
  while (running) {
    const message = await readMessage();
    if (message === null) {
      log('stdin closed, exiting');
      break;
    }

    const action = message['action'] as string | undefined;
    log(`received: ${action ?? 'response'}`);

    processMessage(message, launcher);
  }

  shutdown(poller, monitor, launcher);
}

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error
    ? `${reason.message}\n${reason.stack ?? ''}`
    : String(reason);
  process.stderr.write(`[KitsuneMCP:NativeHost] unhandledRejection: ${msg}\n`);
});

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  log(`fatal error: ${msg}`);
  process.exit(1);
});
