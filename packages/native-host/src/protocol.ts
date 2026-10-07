/**
 * Native Messaging binary frame I/O.
 *
 * Wire format: [4-byte LE uint32 length][UTF-8 JSON payload]
 *
 * Size limits (MDN "Native messaging", App side):
 *   - host → extension: 1 MB  ("The maximum size of a single message from
 *     the application is 1 MB.")  → ENV_DEFAULTS.NATIVE_MSG_MAX_SIZE
 *   - extension → host: 4 GB  ("The maximum size of a message sent to the
 *     application is 4 GB.")  → we cap at NATIVE_MSG_MAX_INCOMING_SIZE
 *     (64 MB), enough for full-page / all-tabs screenshot data URLs.
 *
 * An oversized or unparsable incoming frame is skipped (its bytes are
 * drained so the stream stays in sync) and reported as `skipped` — it is
 * NOT confused with EOF, so the host process keeps running.
 */

import { ENV_DEFAULTS, isRecord } from '@kitsune-mcp/shared';
import { log } from './logger.js';

const MAX_OUTGOING_SIZE = ENV_DEFAULTS.NATIVE_MSG_MAX_SIZE;
const MAX_INCOMING_SIZE = ENV_DEFAULTS.NATIVE_MSG_MAX_INCOMING_SIZE;
const LENGTH_BYTES = 4;
/** Chunk size used when draining an oversized frame. */
const DRAIN_CHUNK = 1_048_576;
/** Bytes peeked from an oversized frame to recover its requestId. */
const PEEK_BYTES = 4_096;

/** Result of one {@link readMessage} call. */
export type ReadResult =
  | { kind: 'message'; message: Record<string, unknown> }
  /** stdin closed (Firefox disconnected the port) — the host should exit. */
  | { kind: 'eof' }
  /**
   * A frame was received but could not be used. The stream is still in sync;
   * keep reading. `requestId` is set when it could be recovered, so the
   * caller can fail the matching server request immediately.
   */
  | { kind: 'skipped'; reason: string; requestId?: string };

/**
 * Read exactly `n` bytes from stdin. Returns null on EOF or short read.
 */
function readExact(n: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin;

    if (stdin.readableEnded) {
      resolve(null);
      return;
    }

    function tryRead(): void {
      const chunk = stdin.read(n) as Buffer | null;
      if (chunk !== null) {
        cleanup();
        resolve(chunk);
        return;
      }
    }

    function onReadable(): void {
      tryRead();
    }

    function onEnd(): void {
      cleanup();
      resolve(null);
    }

    function onError(err: Error): void {
      cleanup();
      log(`stdin read error: ${err.message}`);
      resolve(null);
    }

    function cleanup(): void {
      stdin.removeListener('readable', onReadable);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
    }

    stdin.on('readable', onReadable);
    stdin.on('end', onEnd);
    stdin.on('error', onError);

    // Try immediately in case data is already buffered
    tryRead();
  });
}

/**
 * Consume and discard `n` bytes in bounded chunks.
 * Returns false if EOF was hit before all bytes were drained.
 */
async function drain(n: number): Promise<boolean> {
  let remaining = n;
  while (remaining > 0) {
    const size = Math.min(remaining, DRAIN_CHUNK);
    const chunk = await readExact(size);
    if (chunk === null || chunk.length < size) return false;
    remaining -= size;
  }
  return true;
}

/** Best-effort `"requestId":"…"` extraction from the head of a frame. */
function peekRequestId(head: Buffer): string | undefined {
  const match = /"requestId"\s*:\s*"([^"\\]{1,128})"/.exec(head.toString('utf-8'));
  return match?.[1];
}

/**
 * Read one Native Messaging frame from stdin.
 */
export async function readMessage(): Promise<ReadResult> {
  const lengthBuf = await readExact(LENGTH_BYTES);
  if (lengthBuf === null || lengthBuf.length < LENGTH_BYTES) return { kind: 'eof' };

  const messageLength = lengthBuf.readUInt32LE(0);

  if (messageLength === 0) {
    return { kind: 'skipped', reason: 'empty frame' };
  }

  if (messageLength > MAX_INCOMING_SIZE) {
    const peekSize = Math.min(PEEK_BYTES, messageLength);
    const head = await readExact(peekSize);
    if (head === null || head.length < peekSize) return { kind: 'eof' };
    const requestId = peekRequestId(head);
    if (!(await drain(messageLength - peekSize))) return { kind: 'eof' };
    const reason =
      `incoming message too large: ${messageLength} bytes (max ${MAX_INCOMING_SIZE}), skipped`;
    log(reason);
    return requestId !== undefined
      ? { kind: 'skipped', reason, requestId }
      : { kind: 'skipped', reason };
  }

  const messageBuf = await readExact(messageLength);
  if (messageBuf === null || messageBuf.length < messageLength) {
    log('unexpected EOF while reading message body');
    return { kind: 'eof' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(messageBuf.toString('utf-8'));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const reason = `failed to parse incoming message as JSON: ${msg}`;
    log(reason);
    const requestId = peekRequestId(messageBuf.subarray(0, PEEK_BYTES));
    return requestId !== undefined
      ? { kind: 'skipped', reason, requestId }
      : { kind: 'skipped', reason };
  }

  if (!isRecord(parsed)) {
    const reason = 'incoming message is not a JSON object';
    log(reason);
    return { kind: 'skipped', reason };
  }

  return { kind: 'message', message: parsed };
}

/**
 * Write one Native Messaging frame to stdout.
 * Returns false (and writes nothing) if the frame exceeds Firefox's 1 MB
 * host → extension limit.
 */
export function sendMessage(message: Record<string, unknown>): boolean {
  const encoded = Buffer.from(JSON.stringify(message), 'utf-8');

  if (encoded.length > MAX_OUTGOING_SIZE) {
    log(`outgoing message too large: ${encoded.length} bytes (max ${MAX_OUTGOING_SIZE})`);
    return false;
  }

  const lengthBuf = Buffer.alloc(LENGTH_BYTES);
  lengthBuf.writeUInt32LE(encoded.length, 0);

  process.stdout.write(lengthBuf);
  process.stdout.write(encoded);
  return true;
}
