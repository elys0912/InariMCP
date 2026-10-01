import { logStamp, stampLines } from '@kitsune-mcp/shared/node';

// Rotation and line stamps are shared with the Native Host.
export { MAX_LOG_BYTES, logStamp, rotateIfLarge, stampLines } from '@kitsune-mcp/shared/node';

/**
 * Prefix every line the process writes to stderr with a timestamp and the
 * PID. Used by the daemon, whose stderr is ~/.kitsune-mcp/logs/daemon.log:
 * every module logs with process.stderr.write, so the stream is wrapped once
 * instead of changing each logger.
 */
export function installStderrTimestamps(
  stream: NodeJS.WriteStream = process.stderr,
  stamp: () => string = () => logStamp(),
): void {
  let atLineStart = true;
  const original = stream.write.bind(stream) as (chunk: string, cb?: (err?: Error | null) => void) => boolean;
  const write = (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    const text =
      typeof chunk === 'string'
        ? typeof encodingOrCb === 'string' && encodingOrCb !== 'utf8' && encodingOrCb !== 'utf-8'
          ? Buffer.from(chunk, encodingOrCb).toString('utf-8')
          : chunk
        : Buffer.from(chunk).toString('utf-8');
    const stamped = stampLines(text, atLineStart, stamp());
    atLineStart = stamped.atLineStart;
    return original(stamped.text, typeof encodingOrCb === 'function' ? encodingOrCb : cb);
  };
  stream.write = write as typeof stream.write;
}
