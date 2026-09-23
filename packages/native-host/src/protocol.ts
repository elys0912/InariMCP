/**
 * Native Messaging binary frame I/O.
 *
 * Wire format: [4-byte LE uint32 length][UTF-8 JSON payload]
 * Max payload: 1 MB (Firefox Native Messaging limit)
 */

import { ENV_DEFAULTS } from '@kitsune-mcp/shared';

const MAX_SIZE = ENV_DEFAULTS.NATIVE_MSG_MAX_SIZE;
const LENGTH_BYTES = 4;

function log(msg: string): void {
  process.stderr.write(`[KitsuneMCP:NativeHost] ${msg}\n`);
}

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
 * Read one Native Messaging frame from stdin.
 * Returns the parsed JSON object, or null on EOF / closed stdin.
 */
export async function readMessage(): Promise<Record<string, unknown> | null> {
  const lengthBuf = await readExact(LENGTH_BYTES);
  if (lengthBuf === null || lengthBuf.length < LENGTH_BYTES) return null;

  const messageLength = lengthBuf.readUInt32LE(0);

  if (messageLength === 0) return null;

  if (messageLength > MAX_SIZE) {
    log(`message too large: ${messageLength} bytes (max ${MAX_SIZE})`);
    return null;
  }

  const messageBuf = await readExact(messageLength);
  if (messageBuf === null || messageBuf.length < messageLength) {
    log('unexpected EOF while reading message body');
    return null;
  }

  const text = messageBuf.toString('utf-8');
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`failed to parse incoming message as JSON: ${msg}`);
    return null;
  }
}

/**
 * Write one Native Messaging frame to stdout.
 */
export function sendMessage(message: Record<string, unknown>): void {
  const encoded = Buffer.from(JSON.stringify(message), 'utf-8');

  if (encoded.length > MAX_SIZE) {
    log(`outgoing message too large: ${encoded.length} bytes (max ${MAX_SIZE})`);
    return;
  }

  const lengthBuf = Buffer.alloc(LENGTH_BYTES);
  lengthBuf.writeUInt32LE(encoded.length, 0);

  process.stdout.write(lengthBuf);
  process.stdout.write(encoded);
}
