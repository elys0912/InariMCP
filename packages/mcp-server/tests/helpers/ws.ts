/**
 * Helpers for tests that talk to the ws-bridge as a client, implementing
 * the challenge-response handshake by hand (transport/auth.ts).
 */

import WebSocket from 'ws';
import { AUTH_PROTOCOL, MAC_LABEL, computeMac, newNonce } from '@kitsune-mcp/shared/node';

export const TOKEN = 'f'.repeat(64);

/** Resolve with the next JSON frame. */
export function nextFrame(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData): void => {
      cleanup();
      resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
    };
    const onClose = (code: number): void => {
      cleanup();
      reject(new Error(`closed (${code}) before a frame arrived`));
    };
    const cleanup = (): void => {
      ws.off('message', onMessage);
      ws.off('close', onClose);
    };
    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

/** Resolve with the close code. */
export function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve(-1);
      return;
    }
    ws.once('close', (code: number) => resolve(code));
  });
}

/** Open a client; the challenge is its first frame. */
export async function connect(
  port: number,
  options: WebSocket.ClientOptions = {},
): Promise<{ ws: WebSocket; challenge: Record<string, unknown> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, options);
  ws.on('error', () => { /* surfaced through 'close' */ });
  const challenge = await nextFrame(ws);
  return { ws, challenge };
}

/** Full handshake with the given token; returns the auth_ok frame and nonces. */
export async function authenticate(
  port: number,
  token: string = TOKEN,
  options: WebSocket.ClientOptions = {},
): Promise<{ ws: WebSocket; ok: Record<string, unknown>; serverNonce: string; clientNonce: string }> {
  const { ws, challenge } = await connect(port, options);
  const serverNonce = String(challenge['nonce']);
  const clientNonce = newNonce();
  ws.send(JSON.stringify({
    type: 'auth',
    protocol: AUTH_PROTOCOL,
    nonce: clientNonce,
    mac: computeMac(token, MAC_LABEL.wsClient, serverNonce, clientNonce),
  }));
  const ok = await nextFrame(ws);
  return { ws, ok, serverNonce, clientNonce };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `cond` until it holds or `timeoutMs` passes. */
export async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(10);
  }
}
