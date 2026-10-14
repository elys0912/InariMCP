/**
 * Who owns the HTTP port the daemon could not bind (singleton check).
 *
 * The /health answer is checked like the relays and the Native Host check
 * it: only a daemon that proves it holds our API token (the nonce proof)
 * counts as "another InariMCP daemon". Anything else on the port is
 * reported for what it is, not as a healthy daemon.
 */

import * as http from 'node:http';
import { AUTH_HEADER, evaluateHealth, newNonce, type HealthVerdict } from '@inari-mcp/shared/node';

/** How long a check of a running daemon waits for its answer (this probe; the doctor's /health and /daemon/info). */
export const HEALTH_PROBE_TIMEOUT_MS = 2_000;

export function probeExistingDaemon(host: string, port: number, apiToken: string): Promise<HealthVerdict> {
  const nonce = newNonce();
  return new Promise((resolve) => {
    const req = http.get(
      { host, port, path: '/health', timeout: HEALTH_PROBE_TIMEOUT_MS, headers: { [AUTH_HEADER.nonce]: nonce } },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => resolve(evaluateHealth(res.statusCode, body, apiToken, nonce)));
        res.on('error', () => resolve({ kind: 'down' }));
      },
    );
    req.on('error', () => resolve({ kind: 'down' }));
    req.on('timeout', () => { req.destroy(); resolve({ kind: 'down' }); });
  });
}
