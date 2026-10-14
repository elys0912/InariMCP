import { logStamp, stampLines } from '@inari-mcp/shared/node';

// Rotation and line stamps are shared with the Native Host.
export { MAX_LOG_BYTES, logStamp, rotateIfLarge, stampLines } from '@inari-mcp/shared/node';

/** Encodings whose string spells out bytes (decoded to text before stamping). */
const BYTE_STRING_ENCODINGS: ReadonlySet<BufferEncoding> = new Set<BufferEncoding>(['hex', 'base64', 'base64url']);

type WriteCallback = (err?: Error | null) => void;

/**
 * Both overloads of stream.write — (chunk, cb?) and (chunk, encoding?, cb?) —
 * in one signature, so a replacement can be assigned without a cast.
 */
type StreamWrite = (
  chunk: string | Uint8Array,
  encodingOrCb?: BufferEncoding | WriteCallback,
  cb?: WriteCallback,
) => boolean;

/**
 * Prefix every line the process writes to stderr with a timestamp and the
 * PID. Used by the daemon, whose stderr is ~/.inari-mcp/logs/daemon.log:
 * every module logs with process.stderr.write, so the stream is wrapped once
 * instead of changing each logger.
 */
export function installStderrTimestamps(
  stream: NodeJS.WriteStream = process.stderr,
  stamp: () => string = () => logStamp(),
): void {
  let atLineStart = true;
  const original = stream.write.bind(stream);
  const write: StreamWrite = (chunk, encodingOrCb, cb) => {
    // Only a binary-to-text encoding makes the string stand for bytes; with
    // a text encoding (latin1, utf16le, …) the string is already the text.
    const text =
      typeof chunk === 'string'
        ? typeof encodingOrCb === 'string' && BYTE_STRING_ENCODINGS.has(encodingOrCb)
          ? Buffer.from(chunk, encodingOrCb).toString('utf-8')
          : chunk
        : Buffer.from(chunk).toString('utf-8');
    const stamped = stampLines(text, atLineStart, stamp());
    atLineStart = stamped.atLineStart;
    return original(stamped.text, typeof encodingOrCb === 'function' ? encodingOrCb : cb);
  };
  stream.write = write;
}
