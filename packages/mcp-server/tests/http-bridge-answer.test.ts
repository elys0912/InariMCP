/**
 * an answer that cannot be written (JSON.stringify throws on a BigInt)
 * is answered 500 with the reason and logged, instead of leaving the request
 * open as an unhandled rejection.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOKEN } from './helpers/ws.js';

vi.mock('../src/tools/handlers.js', () => ({
  createToolHandler: () => () => Promise.resolve({ content: [], unencodable: BigInt(1) }),
}));

const { getConnectionManager } = await import('../src/connection/manager.js');
const { startHttpBridge } = await import('../src/transport/http-bridge.js');

let server: http.Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  vi.restoreAllMocks();
});

function post(port: number, urlPath: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: urlPath,
        headers: { 'X-API-Key': TOKEN, 'Content-Type': 'application/json' },
      },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => { text += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('runTrackedCall when the answer throws', () => {
  it('answers 500 with the reason and logs it', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    server = await startHttpBridge({ host: '127.0.0.1', port: 0, apiToken: TOKEN, connectionManager: getConnectionManager() });
    const { port } = server.address() as AddressInfo;

    const r = await post(port, '/mcp/call', JSON.stringify({ name: 'fox_safety_status', arguments: {} }));

    expect(r.status).toBe(500);
    expect(r.text).toContain('the answer could not be written');
    expect(stderr.mock.calls.some(([line]) => String(line).includes('HTTP answer could not be written'))).toBe(true);
  });
});
