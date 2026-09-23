/**
 * HTTP command poller.
 *
 * Polls the MCP server's /browser/poll endpoint at a fixed interval
 * and forwards any queued commands to the Extension via sendMessage().
 */

import * as http from 'node:http';
import { ENV_DEFAULTS } from '@kitsune-mcp/shared';
import { sendMessage } from './protocol.js';

function log(msg: string): void {
  process.stderr.write(`[KitsuneMCP:NativeHost] ${msg}\n`);
}

export class CommandPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  private readonly host: string;
  private readonly port: number;
  private readonly apiToken: string | undefined;

  constructor(host: string, port: number, apiToken?: string) {
    this.host = host;
    this.port = port;
    this.apiToken = apiToken;
  }

  start(): void {
    if (this.timer !== null) return;

    this.timer = setInterval(() => {
      void this.poll();
    }, ENV_DEFAULTS.POLL_INTERVAL_MS);

    // First poll immediately
    void this.poll();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    // Prevent overlapping polls
    if (this.polling) return;
    this.polling = true;

    try {
      const data = await this.httpGet('/browser/poll');
      if (data === null) return;

      const command = data['command'] as Record<string, unknown> | null;
      if (command) {
        const action = command['action'] as string | undefined;
        log(`got command from server: ${action ?? 'unknown'}`);
        sendMessage(command);
      }
    } catch {
      // Server not reachable — health monitor handles restart
    } finally {
      this.polling = false;
    }
  }

  private httpGet(urlPath: string): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const headers: Record<string, string> = {};
      if (this.apiToken) {
        headers['X-API-Key'] = this.apiToken;
      }

      const req = http.request(
        {
          hostname: this.host,
          port: this.port,
          path: urlPath,
          method: 'GET',
          headers,
          timeout: 5_000,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => {
            try {
              resolve(JSON.parse(body) as Record<string, unknown>);
            } catch {
              resolve(null);
            }
          });
        },
      );

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });

      req.end();
    });
  }
}
